
import * as chalk from 'chalk';
import {resolve, sep} from 'path';
import {DbAdapter} from './adapter';
import {Commit} from './git';
import glob = require('globby');

export type MigrationType = 'up' | 'down';

export class MigrationNotFoundError extends Error {
    constructor(public migration: Migration, public migrationDir: string) {
        super('Error: Migration file ' + migrationDir + sep + chalk.bold(migration.name) + '.js does not exist');
    }
}
export class MigrationTypeNotFoundError extends Error {
    constructor(public migration: Migration, public migrationType: MigrationType, public migrationDir: string) {
        super('Error: Migration file ' + migrationDir + sep + chalk.bold(migration.name) + '.js does not export an up function');
    }
}
export class MigrationExecutionError extends Error {
    constructor(public original: any) {
        super(chalk.red(chalk.bold('Migration error: ') + original.stack || original));
    }
}

export class Migration {

    /** The name of the migration */
    public name: string;

    constructor(options?: { name?: string }) {
        Object.assign(this, options);
    }

    /**
     * @param migrationDir The migration directory
     */
    public async getPath(migrationDir: string): Promise<string> {
        const basePath = resolve(migrationDir, this.name);
        const files = await glob(basePath + '*.*');
        if (files.length === 0) {
            throw new MigrationNotFoundError(this, migrationDir);
        }
        return files[0];
    }
}

export class Task {

    /** The function that was executed */
    public type: MigrationType;

    /** The migration that was run */
    public migration: Migration;

    // If the task was already executed:

    /** The sequential id of the task entry in the database */
    public id: number;

    /** The commit that triggered the task, if triggered by a commit */
    public commit: Commit;

    /** The git HEAD at the time the task was executed */
    public head: Commit;

    /** The date when the migration was applied if already executed */
    public appliedAt: Date;

    constructor(options?: { id?: number, type?: MigrationType, migration?: Migration, commit?: Commit, head?: Commit, appliedAt?: Date }) {
        Object.assign(this, options);
    }

    /**
     * Executes the task
     */
    public async execute(migrationDir: string, adapter: DbAdapter, head: Commit, commit?: Commit): Promise<void> {
        await adapter.checkIfTaskCanExecute(this);
        let migrationExports: any;
        try {
            const path = await this.migration.getPath(migrationDir);
            migrationExports = require(path);
        } catch (err) {
            throw new MigrationNotFoundError(this.migration, migrationDir);
        }
        if (typeof migrationExports.up !== 'function') {
            throw new MigrationTypeNotFoundError(this.migration, this.type, migrationDir);
        }
        try {
            let exceptionHandler: Function;
            try {
                await Promise.race([
                    new Promise((resolve, reject) => {
                        exceptionHandler = reject;
                        process.on('uncaughtException', reject);
                    }),
                    Promise.resolve(migrationExports.up())
                ]);
            } finally {
                process.removeListener('uncaughtException', exceptionHandler);
            }
        } catch (err) {
            throw new MigrationExecutionError(err);
        }
        this.head = head;
        this.commit = commit;
        this.appliedAt = new Date();
        await adapter.logMigrationTask(this);
    }

    /**
     * Converts the task to a short string including the type and migration name that can be shown
     * in the CLI
     */
    public toString(): string {
        if (this.type === 'up') {
            return chalk.bgGreen('▲ UP   ' + this.migration.name);
        } else if (this.type === 'down') {
            return chalk.bgRed('▼ DOWN ' + this.migration.name);
        } else {
            throw new Error('Unknown migration type ' + this.type);
        }
    }
}