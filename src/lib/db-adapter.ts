const isElectron = typeof window !== 'undefined' && (window as any).electron?.isElectron;

interface QueryBuilder {
  select: (columns?: string) => QueryBuilder;
  insert: (data: any) => QueryBuilder;
  update: (data: any) => QueryBuilder;
  delete: () => QueryBuilder;
  eq: (column: string, value: any) => QueryBuilder;
  in: (column: string, values: any[]) => QueryBuilder;
  order: (column: string, options?: { ascending?: boolean }) => QueryBuilder;
  maybeSingle: () => Promise<{ data: any; error: any }>;
  single: () => Promise<{ data: any; error: any }>;
  then: (resolve: any, reject: any) => Promise<any>;
}

class MySQLQueryBuilder implements QueryBuilder {
  private tableName: string;
  private operation: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private selectColumns: string = '*';
  private whereConditions: Array<{ column: string; operator: string; value: any }> = [];
  private orderByClause: string = '';
  private insertData: any = null;
  private updateData: any = null;
  private shouldReturnInserted: boolean = false;

  constructor(tableName: string) {
    this.tableName = tableName;
  }

  select(columns: string = '*') {
    if (this.operation === 'insert') {
      this.shouldReturnInserted = true;
      this.selectColumns = columns;
    } else {
      this.operation = 'select';
      this.selectColumns = columns;
    }
    return this;
  }

  insert(data: any) {
    this.operation = 'insert';
    this.insertData = Array.isArray(data) ? data : [data];
    return this;
  }

  update(data: any) {
    this.operation = 'update';
    this.updateData = data;
    return this;
  }

  delete() {
    this.operation = 'delete';
    return this;
  }

  eq(column: string, value: any) {
    this.whereConditions.push({ column, operator: '=', value });
    return this;
  }

  in(column: string, values: any[]) {
    this.whereConditions.push({ column, operator: 'IN', value: values });
    return this;
  }

  order(column: string, options: { ascending?: boolean } = {}) {
    const direction = options.ascending === false ? 'DESC' : 'ASC';
    this.orderByClause = `ORDER BY ${column} ${direction}`;
    return this;
  }

  async maybeSingle() {
    const result = await this.execute();
    if (result.error) return result;
    return {
      data: result.data && result.data.length > 0 ? result.data[0] : null,
      error: null
    };
  }

  async single() {
    const result = await this.execute();
    if (result.error) return result;
    if (!result.data || result.data.length === 0) {
      return { data: null, error: { message: 'No rows found' } };
    }
    return {
      data: result.data[0],
      error: null
    };
  }

  then(resolve: any, reject: any) {
    return this.execute().then(resolve, reject);
  }

  private convertValue(value: any): any {
    if (typeof value === 'string' && value.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)) {
      return new Date(value).toISOString().slice(0, 19).replace('T', ' ');
    }
    if (typeof value === 'object' && value !== null) {
      return JSON.stringify(value);
    }
    return value;
  }

  private buildQuery(): { sql: string; params: any[] } {
    const params: any[] = [];
    let sql = '';

    switch (this.operation) {
      case 'select':
        sql = `SELECT ${this.selectColumns} FROM ${this.tableName}`;
        if (this.whereConditions.length > 0) {
          const whereClauses = this.whereConditions.map(cond => {
            if (cond.operator === 'IN') {
              const placeholders = cond.value.map(() => '?').join(', ');
              params.push(...cond.value);
              return `${cond.column} IN (${placeholders})`;
            } else {
              params.push(cond.value);
              return `${cond.column} ${cond.operator} ?`;
            }
          });
          sql += ` WHERE ${whereClauses.join(' AND ')}`;
        }
        if (this.orderByClause) {
          sql += ` ${this.orderByClause}`;
        }
        break;

      case 'insert':
        if (this.insertData && this.insertData.length > 0) {
          const columns = Object.keys(this.insertData[0]);
          const placeholders = columns.map(() => '?').join(', ');
          sql = `INSERT INTO ${this.tableName} (${columns.join(', ')}) VALUES `;

          const valueSets = this.insertData.map((row: any) => {
            params.push(...columns.map(col => this.convertValue(row[col])));
            return `(${placeholders})`;
          });

          sql += valueSets.join(', ');
        }
        break;

      case 'update':
        if (this.updateData) {
          const setClauses = Object.keys(this.updateData).map(key => {
            params.push(this.convertValue(this.updateData[key]));
            return `${key} = ?`;
          });
          sql = `UPDATE ${this.tableName} SET ${setClauses.join(', ')}`;

          if (this.whereConditions.length > 0) {
            const whereClauses = this.whereConditions.map(cond => {
              params.push(cond.value);
              return `${cond.column} ${cond.operator} ?`;
            });
            sql += ` WHERE ${whereClauses.join(' AND ')}`;
          }
        }
        break;

      case 'delete':
        sql = `DELETE FROM ${this.tableName}`;
        if (this.whereConditions.length > 0) {
          const whereClauses = this.whereConditions.map(cond => {
            params.push(cond.value);
            return `${cond.column} ${cond.operator} ?`;
          });
          sql += ` WHERE ${whereClauses.join(' AND ')}`;
        }
        break;
    }

    return { sql, params };
  }

  private async execute() {
    try {
      const { sql, params } = this.buildQuery();
      console.log('Executing MySQL query:', sql, params);

      const result = await (window as any).electron.db.query(sql, params);

      if (result.error) {
        return {
          data: null,
          error: { message: result.error }
        };
      }

      let data = result.rows || [];

      if (this.operation === 'insert' && result.rows) {
        console.log('Insert completed, insertId:', result.rows.insertId, 'affectedRows:', result.rows.affectedRows);
      }

      if (this.operation === 'insert' && this.shouldReturnInserted && result.rows && result.rows.insertId) {
        console.log('Insert operation detected, insertId:', result.rows.insertId);
        console.log('Affected rows:', result.rows.affectedRows);

        const insertId = result.rows.insertId;
        const affectedRows = result.rows.affectedRows || 1;

        if (affectedRows === 1) {
          const selectSql = `SELECT ${this.selectColumns} FROM ${this.tableName} WHERE id = ?`;
          const selectResult = await (window as any).electron.db.query(selectSql, [insertId]);
          console.log('Retrieved inserted row:', selectResult);

          if (selectResult.error) {
            return {
              data: null,
              error: { message: selectResult.error }
            };
          }

          data = selectResult.rows || [];
        } else {
          const selectSql = `SELECT ${this.selectColumns} FROM ${this.tableName} WHERE id >= ? AND id < ?`;
          const selectResult = await (window as any).electron.db.query(selectSql, [insertId, insertId + affectedRows]);
          console.log('Retrieved inserted rows:', selectResult);

          if (selectResult.error) {
            return {
              data: null,
              error: { message: selectResult.error }
            };
          }

          data = selectResult.rows || [];
        }
      }

      return {
        data,
        error: null
      };
    } catch (error: any) {
      console.error('MySQL query error:', error);
      return {
        data: null,
        error: { message: error.message || 'Database error' }
      };
    }
  }
}

export const createDbAdapter = (supabaseClient: any) => {
  if (isElectron && (window as any).electron?.db?.query) {
    console.log('✓ Using MySQL adapter for Electron');
    return {
      from: (tableName: string) => new MySQLQueryBuilder(tableName)
    };
  }

  if (!supabaseClient) {
    console.warn('⚠ No database client available');
    return null;
  }

  console.log('✓ Using Supabase client');
  return supabaseClient;
};
