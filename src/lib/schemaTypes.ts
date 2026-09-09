// Schema shapes shared by the SQLite and PostgreSQL services, the Text-to-SQL
// prompt builder, and the offline eval harness in `evals/`.
//
// These were previously referenced but never declared, which went unnoticed
// because the root tsconfig has `files: []` and so typechecked nothing.

export type SqlDialect = 'sqlite' | 'postgres';

export interface ColumnSchema {
    name: string;
    type: string;
    isPrimaryKey?: boolean;
    isNotNull?: boolean;
    /**
     * A few distinct values, for low-cardinality text columns only. Lets the
     * model resolve enumerations it would otherwise have to guess at — asked
     * for "customers in Germany" against a column storing 'DE', names and
     * types alone are not enough. Populated by schemaSamples.ts, which owns
     * the eligibility and privacy rules.
     */
    sampleValues?: string[];
}

export interface TableSchema {
    name: string;
    columns: ColumnSchema[];
}

export interface DatabaseSchema {
    dialect: SqlDialect;
    tables: TableSchema[];
}
