import SqlString from 'sqlstring';

interface QueryRaw {
  __typename: 'query_raw';
  raw: string;
  binding?: unknown[];
}

interface QueryWhere {
  mode: 'OR' | 'AND';
  condition?: {
    field: string;
    value: unknown;
    op: string;
  };
  raw?: QueryRaw;
}

interface QueryStates {
  table?: string;
  type: 'select' | 'update' | 'insert' | 'delete';
  insert?: Record<string, unknown>;
  update?: Record<string, unknown>;
  where: QueryWhere[];
  select: (string | QueryRaw)[];
  limit?: number;
  offset?: number;
  orderBy: { name: string; order: 'ASC' | 'DESC' }[];
}

abstract class QueryDialect {
  abstract escapeIdentifier(name: string): string;
  abstract format(sql: string, binding: unknown[]): string;
}

class MySqlDialect implements QueryDialect {
  escapeIdentifier(value: string): string {
    return value !== '*' ? SqlString.escapeId(value) : '*';
  }

  format(sql: string, binding: unknown[]): string {
    return SqlString.format(sql, binding);
  }
}

export class QueryBuilder {
  protected dialect: QueryDialect = new MySqlDialect();
  protected states: QueryStates = {
    type: 'select',
    where: [],
    select: [],
    orderBy: [],
  };

  constructor(dialect: 'mysql') {
    if (dialect === 'mysql') {
      this.dialect = new MySqlDialect();
    }
  }

  protected escapeIdentifier(id: string | QueryRaw) {
    if (typeof id === 'string') {
      return this.dialect.escapeIdentifier(id);
    }

    return id.raw;
  }

  raw(str: string): QueryRaw {
    return {
      __typename: 'query_raw',
      raw: str,
    };
  }

  escapeId(name: string) {
    return this.dialect.escapeIdentifier(name);
  }

  table(name: string) {
    this.states.table = name;
    return this;
  }

  insert(value: Record<string, unknown>) {
    this.states.type = 'insert';
    this.states.insert = { ...this.states.insert, ...value };
    return this;
  }

  update(value: Record<string, unknown>) {
    this.states.type = 'update';
    this.states.update = { ...this.states.update, ...value };
    return this;
  }

  delete() {
    this.states.type = 'delete';
    return this;
  }

  where(conditions: Record<string, unknown>) {
    for (const [field, value] of Object.entries(conditions)) {
      if (value !== undefined) {
        this.states.where.push({
          mode: 'AND',
          condition: {
            field,
            value,
            op: '=',
          },
        });
      }
    }

    return this;
  }

  select(...columns: (string | QueryRaw)[]) {
    this.states.select = this.states.select.concat(columns);
    return this;
  }

  limit(n: number) {
    this.states.limit = n;
    return this;
  }

  offset(n: number) {
    this.states.offset = n;
    return this;
  }

  orderBy(name: string, order: 'ASC' | 'DESC' = 'ASC') {
    this.states.orderBy.push({ name, order });
  }

  protected buildWhere(where: QueryWhere[]): {
    sql: string;
    binding: unknown[];
  } {
    if (where.length === 0) return { sql: '', binding: [] };

    let previousMode = '';
    let sql = '';
    const binding: unknown[] = [];

    for (const whereItem of where) {
      if (whereItem.condition) {
        if (previousMode) sql += ' ' + previousMode + ' ';
        sql +=
          this.dialect.escapeIdentifier(whereItem.condition.field) +
          whereItem.condition.op +
          '?';
        binding.push(whereItem.condition.value);
      }
      previousMode = whereItem.mode;
    }

    return { sql, binding };
  }

  toSQL(): { sql: string; binding: unknown[] } {
    if (this.states.type === 'update') {
      if (!this.states.table) throw 'no table specified';
      if (!this.states.update) throw 'update with no field';
      if (Object.entries(this.states.update).length === 0)
        throw 'update with no field';

      let binding: unknown[] = [];
      const commandPart = `UPDATE ${this.dialect?.escapeIdentifier(
        this.states.table
      )}`;
      const setPart: string[] = [];

      for (const [updateField, updateValue] of Object.entries(
        this.states.update
      )) {
        setPart.push(`${this.dialect?.escapeIdentifier(updateField)}=?`);
        binding.push(updateValue);
      }

      const { sql: whereSql, binding: whereBinding } = this.buildWhere(
        this.states.where
      );
      binding = binding.concat(...whereBinding);

      const sql =
        [
          commandPart,
          'SET ' + setPart.join(','),
          whereSql ? 'WHERE ' + whereSql : whereSql,
        ]
          .filter(Boolean)
          .join(' ') + ';';

      return { sql, binding };
    } else if (this.states.type === 'select') {
      if (!this.states.table) throw 'no table specified';
      let binding: unknown[] = [];

      const selectFieldPart =
        this.states.select.length === 0
          ? '*'
          : this.states.select
              .map((field) => this.escapeIdentifier(field))
              .join(',');

      const { sql: whereSql, binding: whereBinding } = this.buildWhere(
        this.states.where
      );

      binding = binding.concat(...whereBinding);

      let limitPart: string | undefined = undefined;

      if (this.states.limit) {
        if (this.states.offset) {
          binding.push(this.states.offset);
          binding.push(this.states.limit);
          limitPart = 'LIMIT ?,?';
        } else {
          binding.push(this.states.limit);
          limitPart = 'LIMIT ?';
        }
      }

      const sql =
        [
          'SELECT',
          selectFieldPart,
          'FROM',
          this.dialect.escapeIdentifier(this.states.table),
          whereSql ? 'WHERE ' + whereSql : whereSql,
          this.states.orderBy.length > 0
            ? 'ORDER BY ' +
              this.states.orderBy
                .map(
                  ({ name, order }) => `${this.escapeIdentifier(name)} ${order}`
                )
                .join(',')
            : undefined,
          limitPart,
        ]
          .filter(Boolean)
          .join(' ') + ';';

      return { sql, binding };
    } else if (this.states.type === 'delete') {
      if (!this.states.table) throw 'no table specified';

      const { sql: whereSql, binding: whereBinding } = this.buildWhere(
        this.states.where
      );

      let binding: unknown[] = [];
      binding = binding.concat(...whereBinding);

      const sql =
        [
          'DELETE',
          'FROM',
          this.dialect.escapeIdentifier(this.states.table),
          whereSql ? 'WHERE ' + whereSql : whereSql,
          this.states.limit ? `LIMIT ${this.states.limit}` : null,
        ]
          .filter(Boolean)
          .join(' ') + ';';

      return { sql, binding };
    } else if (this.states.type === 'insert') {
      if (!this.states.table) throw 'no table specified';

      if (this.states.insert) {
        const binding: unknown[] = [];
        const fields: string[] = [];

        for (const [field, value] of Object.entries(this.states.insert)) {
          binding.push(value);
          fields.push(field);
        }

        const sql =
          [
            'INSERT INTO',
            this.dialect.escapeIdentifier(this.states.table) +
              '(' +
              fields
                .map((field) => this.dialect.escapeIdentifier(field))
                .join(', ') +
              ')',
            'VALUES(' + new Array(binding.length).fill('?').join(', ') + ')',
          ].join(' ') + ';';

        return { sql, binding };
      }
    }

    throw new Error('Not implemented');
  }

  toRawSQL() {
    const { sql, binding } = this.toSQL();
    return this.dialect.format(sql, binding);
  }
}

export function qb(dialect?: 'mysql') {
  return new QueryBuilder(dialect || 'mysql');
}
