import * as assert from 'assert';
import * as fs from 'mz/fs';
import * as path from 'path';
import * as pg from 'pg';
import {
    Migration,
    MigrationNotFoundError,
    MigrationExecutionError,
    TaskTypeNotFoundError,
    UnknownTaskTypeError,
    Task,
    TaskList
} from '../migration';
import {Commit} from '../git';
import {PostgresAdapter} from '../adapters/postgres';
import * as del from 'del';
import {tmpdir} from 'os';
import * as sinon from 'sinon';

const repo = path.join(tmpdir(), 'merkel_test_api');

describe('migration', () => {
    describe('Migration', () => {
        before(async () => {
            try {
                await fs.access(repo);
            } catch (err) {
                await fs.mkdir(repo);
            }
            process.chdir(repo);
            await del('*', <any>{dot: true});
        });
        describe('getPath()', () => {
            it('should calculate the right path', async () => {
                await fs.mkdir(path.join(repo, 'migrations'));
                await fs.writeFile(path.join('migrations', 'test.js'), 'up');
                const migration = new Migration({name: 'test'});
                assert.equal(await migration.getPath('migrations'), path.resolve('migrations/test.js'));
            });
            it('should throw MigrationNotFoundError for not found migrations', async () => {
                const migration = new Migration();
                try {
                    await migration.getPath('migrations');
                } catch (err) {
                    if (!(err instanceof MigrationNotFoundError)) {
                        throw err;
                    }
                }
            });
        });
        after(async () => {
            await del('*', <any>{dot: true});
        });
    });
    describe('TaskList', () => {
        describe('execute()', () => {
            it('should run all its tasks', async () => {
                const taskList = new TaskList();
                const task = new Task();
                taskList.push(task);
                let stub: sinon.SinonStub;
                try {
                    stub = sinon.stub(task, 'execute');
                    taskList.execute(null, null, null);
                } finally {
                    stub.restore();
                }
                sinon.assert.calledOnce(stub);
            });
        });
        describe('toString()', () => {
            it('should return a string of merkel commands', async () => {
                const taskList = TaskList.from([
                    new Task({type: 'down', migration: new Migration({name: 'a4bdf4cc-f7ed-4785-8bdb-2abfb5ed2025'})}),
                    new Task({type: 'up', migration: new Migration({name: 'e55d537d-ad67-40e6-9ef1-50320e530676'})})
                ]);
                assert.equal(taskList.toString(), '[merkel up e55d537d-ad67-40e6-9ef1-50320e530676]\n[merkel down a4bdf4cc-f7ed-4785-8bdb-2abfb5ed2025]');
            });
            it('should wrap long commands', async () => {
                const taskList = TaskList.from([
                    new Task({type: 'down', migration: new Migration({name: 'a4bdf4cc-f7ed-4785-8bdb-2abfb5ed2025'})}),
                    new Task({type: 'up', migration: new Migration({name: 'e55d537d-ad67-40e6-9ef1-50320e530676'})}),
                    new Task({type: 'up', migration: new Migration({name: '15ca72e9-241c-4fcd-97ad-aeb367403a27'})}),
                    new Task({type: 'up', migration: new Migration({name: 'e55d537d-ad67-40e6-9ef1-50320e530676'})})
                ]);
                assert.equal(taskList.toString(), [
                    '[',
                    '  merkel up',
                    '  e55d537d-ad67-40e6-9ef1-50320e530676',
                    '  15ca72e9-241c-4fcd-97ad-aeb367403a27',
                    '  e55d537d-ad67-40e6-9ef1-50320e530676',
                    ']',
                    '[merkel down a4bdf4cc-f7ed-4785-8bdb-2abfb5ed2025]'
                ].join('\n'));
            });
        });
    });
    describe('Task', () => {
        describe('invert()', () => {
            it('should return a new tasklist that is the inverse of the task', () => {
                const task = new Task({type: 'up'});
                const inverted = task.invert();
                assert.notEqual(task, inverted);
                assert.equal(inverted.type, 'down');
            });
        });
        describe('execute()', () => {
            let client: pg.Client;
            let adapter: PostgresAdapter;
            before(async () => {
                adapter = new PostgresAdapter(process.env.MERKEL_DB, pg);
                await adapter.init();
                client = new pg.Client(process.env.MERKEL_DB);
                await new Promise<void>((resolve, reject) => client.connect(err => err ? reject(err) : resolve()));
                await client.query('DROP TABLE IF EXISTS new_table');
                await client.query('TRUNCATE TABLE merkel_meta RESTART IDENTITY');
            });
            after(() => client.end());
            it('should execute an up task', async () => {
                const task = new Task({type: 'up', migration: new Migration({name: 'test_migration'})});
                const head = new Commit({sha1: 'HEADCOMMITSHA1'});
                const trigger = new Commit({sha1: 'TRIGGERCOMMITSHA1'});
                await task.execute(__dirname + '/migrations', adapter, head, trigger);
                // Check if table was created
                const {rows} = await client.query(`SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE table_name = 'new_table'`);
                assert.equal(rows.length, 1);
            });
            it('should throw a MigrationNotFoundError if the migration is not existent', async () => {
                const task = new Task({type: 'up', migration: new Migration({name: 'not_found'})});
                const head = new Commit({sha1: 'HEADCOMMITSHA1'});
                const trigger = new Commit({sha1: 'TRIGGERCOMMITSHA1'});
                try {
                    await task.execute(__dirname + '/migrations', adapter, head, trigger);
                    throw new assert.AssertionError({
                        message: 'No MigrationNotFoundError was thrown.'
                    });
                } catch (err) {
                    if (!(err instanceof MigrationNotFoundError)) {
                        throw err;
                    }
                }
            });
            it('should throw a TaskTypeNotFoundError if the migration has no up or down function', async () => {
                const task = new Task({type: 'up', migration: new Migration({name: 'no_up'})});
                const head = new Commit({sha1: 'HEADCOMMITSHA1'});
                const trigger = new Commit({sha1: 'TRIGGERCOMMITSHA1'});
                try {
                    await task.execute(__dirname + '/migrations', adapter, head, trigger);
                    throw new assert.AssertionError({
                        message: 'No TaskTypeNotFoundError was thrown.'
                    });
                } catch (err) {
                    if (!(err instanceof TaskTypeNotFoundError)) {
                        throw err;
                    }
                }
            });
            it('should throw a MigrationExecutionError when the migration returns a rejected promise', async () => {
                const task = new Task({type: 'up', migration: new Migration({name: 'error_async'})});
                const head = new Commit({sha1: 'HEADCOMMITSHA1'});
                const trigger = new Commit({sha1: 'TRIGGERCOMMITSHA1'});
                try {
                    await task.execute(__dirname + '/migrations', adapter, head, trigger);
                    throw new assert.AssertionError({
                        message: 'No MigrationExecutionError was thrown.'
                    });
                } catch (err) {
                    if (!(err instanceof MigrationExecutionError)) {
                        throw err;
                    }
                }
            });
            it('should throw a MigrationExecutionError when the migration throws sync', async () => {
                const task = new Task({type: 'up', migration: new Migration({name: 'error_sync'})});
                const head = new Commit({sha1: 'HEADCOMMITSHA1'});
                const trigger = new Commit({sha1: 'TRIGGERCOMMITSHA1'});
                try {
                    await task.execute(__dirname + '/migrations', adapter, head, trigger);
                    throw new assert.AssertionError({
                        message: 'No Migration ExecutionError was thrown.'
                    });
                } catch (err) {
                    if (!(err instanceof MigrationExecutionError)) {
                        throw err;
                    }
                }
            });
            it('should throw a MigrationExecutionError when the migration would crash the process', async () => {
                const task = new Task({type: 'up', migration: new Migration({name: 'error_crash'})});
                const head = new Commit({sha1: 'HEADCOMMITSHA1'});
                const trigger = new Commit({sha1: 'TRIGGERCOMMITSHA1'});
                let listener: Function;
                try {
                    listener = process.listeners('uncaughtException').pop();
                    process.removeListener('uncaughtException', listener);
                    await task.execute(__dirname + '/migrations', adapter, head, trigger);
                    throw new assert.AssertionError({
                        message: 'No Migration ExecutionError was thrown.'
                    });
                } catch (err) {
                    if (!(err instanceof MigrationExecutionError)) {
                        throw err;
                    }
                } finally {
                    process.addListener('uncaughtException', listener);
                }
            });
        });
        describe('toString', () => {
            it('should throw if the task type is unknown', async () => {
                const task = new Task(<any>{type: 'd'});
                try {
                    task.toString();
                    throw new assert.AssertionError({
                        message: 'Task did not throw error on toString with wrong type'
                    });
                } catch (err) {
                    if (!(err instanceof UnknownTaskTypeError)) {
                        throw err;
                    }
                }
            });
        });
    });
});
