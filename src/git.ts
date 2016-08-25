
import {exec} from 'mz/child_process';
import * as chalk from 'chalk';
import {Migration, MigrationType, Task, TaskList} from './migration';
import {resolve, basename} from 'path';

export class Commit {

    /** The commit SHA1 */
    sha1: string;

    /** The commit message, without tasks */
    message: string;

    /** Migrations that should be run, in the order they were defined in the commit message */
    tasks: TaskList = new TaskList();

    /** The first 6 letters of the SHA1 */
    get shortSha1(): string {
        return this.sha1.substring(0, 7);
    }

    /** The first line of the commit message */
    get subject(): string {
        return this.message && this.message.split('\n', 1)[0];
    }

    constructor(options?: { sha1?: string, message?: string, tasks?: TaskList }) {
        Object.assign(this, options);
    }

    /**
     * Loads more info by using `git show <sha1>`
     */
    public async loadSubject(): Promise<void> {
        if (this.message === undefined) {
            const [stdout] = await exec(`git log --format=%B ${this.sha1}`);
            this.message = stdout.toString();
        }
    }

    public toString(): string {
        return chalk.yellow(this.shortSha1) + ' ' + (this.subject ? this.subject : '<unknown commit>');
    }
}

/**
 * Gets all commits in the migration dir since the last migration head
 * @param from The commit sha1 of the commit when the last migration was running
 */
export async function getNewCommits(from?: Commit): Promise<Commit[]> {
    let command = 'git log --reverse --format=">>>>COMMIT%n%H%n%B"';
    let stdout: Buffer;
    try {
        [stdout] = await exec(command + (from ? ` ${from.sha1}..HEAD` : ''));
    } catch (err) {
        if (err.code !== 128) {
            throw err;
        }
        // the last migration head does not exist in this repository
        [stdout] = await exec(command);
    }
    const output = stdout.toString().trim();
    return parseGitLog(output);
}

/**
 * Parses the output of `git log --reverse --format=">>>>COMMIT%n%H%n%B" ${lastMigrationHead}`.
 */
export function parseGitLog(gitLog: string): Commit[] {
    if (gitLog === '') {
        return [];
    }
    const commitStrings = gitLog.substr('>>>>COMMIT\n'.length).split('>>>>COMMIT\n');
    const commits = commitStrings.map(s => {
        let [, sha1, message] = s.match(/^(\w+)\n((?:.|\n|\r)*)$/);
        const commit = new Commit({ sha1 });
        // get commands from message
        const regExp = /\[\s*merkel[^\]]*\s*\]/g;
        const match = message.match(regExp);
        const commands: string[][] = match ? match.map(command => command.replace(/^\s*\[\s*/, '').replace(/\s*\]\s*$/, '').split(/\s+/g).slice(1)) : [];
        for (const command of commands) {
            const type = <MigrationType>command.shift();
            for (const name of command) {
                commit.tasks.push(new Task({ type, migration: new Migration({ name }), commit }));
            }
        }
        // strip commands from message
        commit.message = message.replace(regExp, '');
        return commit;
    });
    return commits;
}

/**
 * Gets the SHA1 of the current git HEAD
 */
export async function getHead(): Promise<Commit> {
    const [stdout] = await exec('git rev-parse HEAD');
    return new Commit({ sha1: stdout.toString().trim() });
}

export async function getTasksForNewCommit(message: string, migrationDir: string): Promise<TaskList> {
    migrationDir = resolve(migrationDir);
    const [stdout] = await exec('git diff --staged --name-status');
    const output = stdout.toString().trim();
    const tasks: TaskList = new TaskList();
    // added migration files should be executed up
    for (const line of output.split('\n')) {
        const status = line.charAt(0);
        const file = resolve(line.substr(1).trim());
        if (status === 'A' && file.startsWith(migrationDir)) {
            const name = basename(file).replace(/\.\w*$/, '');
            tasks.push(new Task({ migration: new Migration({ name }) }));
        }
    }
    return tasks;
}

export function isRevertCommit(message: string): boolean {
    return /Revert/.test(message);
}

/**
 * Adds the migration directory back to the index
 */
export async function addMigrationDir(migrationDir: string): Promise<void> {
    await exec(`git add ${migrationDir}`);
};
