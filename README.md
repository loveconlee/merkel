
# `merkel`
> _Handles your database migration crisis_

[![Version](https://img.shields.io/npm/v/merkel.svg?maxAge=2592000)](https://www.npmjs.com/package/merkel)
[![Downloads](https://img.shields.io/npm/dt/merkel.svg?maxAge=2592000)](https://www.npmjs.com/package/merkel)
[![Build Status](https://travis-ci.org/felixfbecker/merkel.svg?branch=master)](https://travis-ci.org/felixfbecker/merkel)
[![Coverage](https://codecov.io/gh/felixfbecker/merkel/branch/master/graph/badge.svg?token=BuoxrgBs54)](https://codecov.io/gh/felixfbecker/merkel)
[![Dependency Status](https://gemnasium.com/badges/github.com/felixfbecker/merkel.svg)](https://gemnasium.com/github.com/felixfbecker/merkel)
![Node Version](http://img.shields.io/node/v/merkel.svg)
[![License](https://img.shields.io/npm/l/merkel.svg?maxAge=2592000)](https://github.com/felixfbecker/merkel/blob/master/LICENSE.txt)


`merkel` is a framework-agnostic database migration tool designed to autonomously run in Continuous Deployment,
with rollbacks in mind.

## Installation

`npm install --global merkel` or `npm install --save-dev merkel`

Run `merkel init` to initialize a `.merkelrc.json` and install a git hook

> **Is the `.merkelrc.json` required?**  
> No, but it holds the migration directory, and if you use it, you could change it later
> because the migration directory at any time is known through git.

  

> **Is the git hook required?**  
> No, but it helps you type less. Read on to learn more.


## Workflow


### Make changes to your model files

Let's say you made some changes to your model files that require a database migration.

### Generate a migration file

Before you commit, create a new migration file by running `merkel generate`.
This will generate a new migration file inside your migration directory (default `./migrations`).
If a `tsconfig.json` was detected, the migration file will be in TypeScript.
You can change the migration directory with `--migration-dir` and provide a custom template with `--template`.
Like all options, they can also be set in `.merkelrc.json` or passed through environment variables.
The name of the migration file can be set with `--name`. By default, a UUID is used.

> **Why UUIDs?**  
> In opposite to sequential IDs or timestamps, UUIDs allow seperate developers to write migration files without any
> conflicts. There can be migration files introduced in seperate git branches or commits with migration files even
> cherry-picked accross repositories, they will not create merge conflicts.
> This works well with the distributed nature of git.
> Providing a custom, unique name is equally good.

### Write your migration file

You migration file exports two functions: `up` and `down`.
The `up` function is expected to make all necessary database changes compared to the previous commit.
The `down` function should try to reverse as good as possible. Both functions should return a Promise.
Your migration file can use any dependency you want to execute this task, import a database connection,
use a low-level driver or high-level ORM, use the AWS SDK, spawn child processes...

Example:

```js
const db = require('../db');

exports.up = function up() {
  return new Promise((resolve, reject) => db.connect(err => err ? reject(err) : resolve()))
    .then(() => db.query('ALTER TABLE order_details RENAME COLUMN notes TO order_notes'));
}

exports.down = function down() {
  return new Promise((resolve, reject) => db.connect(err => err ? reject(err) : resolve()))
    .then(() => db.query('ALTER TABLE order_details RENAME COLUMN order_notes TO notes'));
}
```

Where `db.js` could look like this:

```js
const pg = require('pg');

module.exports = new pg.Client(process.env.DB);
```

### Commit

Add your model changes and the migration file, and run `git commit`.
If you installed the git hook, you will see that merkel detected that you added a migration file and included a
command like this in your commit message:

```
[merkel up d12f99e4-710d-4d4a-94f8-13d9d121bac5]
```

This command will later be parsed by `merkel migrate`. 

### Migrate

After checking out the new commit in Continuous Deployment or on a coworker's machine, run `merkel migrate`.
merkel will query the database's `merkel_meta` table for the last migration run, and what the `HEAD` was when that
migration was run.

To being able to do this, you must provide `merkel` with a database connection URI.
You can do this either through the `--db` option or through the `MERKEL_DB` environment variable.
It is not recommended to save this in the `.merkelrc.json` file, as connection data differs across environments.

To query the database, `merkel` needs a database driver.
The driver is detected through the protocol part of the connection URI.
In order to allow many dialects, it is not a dependency of `merkel`, but instead `require`d from the current working
directory, which means you need one installed in your project (you probably already have). See supported dialects.

`merkel` then asks `git` which commits were made since then the last migration.
It then scans the new commits for the `merkel` commands like you saw in the example above.

```
Pending migrations:
```

> The confirmation prompt will only show up if run in a TTY context and can be disabled with `--confirm=false`.
> To get only status output, run `merkel status`.

`merkel` will then execute the migrations in that exact order, and log these in the database as they happen.

## But...

### What if a migration fails?

If a migration fails (throws an exception / returns a rejected promise), the schema your source files expect doesn't
match your database schema anymore. You now have two options:
 - Quickly fix the migration file in a seperate commit.
   That commit message should _not_ include any `merkel` command.
   The next `merkel migrate` execution will then start where it migration chain broke and will still run the migration
   files in the order they were specified in the commit messages, but with the newest version of the migration file.
 - Completely revert the deployment to the previous state, see reverting migrations

### What if I need to revert a deployment?

#### Reverting a deployment with `git revert`

When you do a `git revert`, normally `git` will create a commit that is the exact inverse of the commits you want to
invert. This means, if one of the commits added a migration file, it will now be deleted. **This is not desirable**.
Instead of deleting the migration files, you want to keep them, but let `merkel` migrate them _down_.

To accomplish this, make sure to run `git revert` with the `--no-commit`/`-n` option.
This will not make the commit immidietly, but only stage the proposed changes, allowing you to edit them.

Run `git status` to see if any migration files got deleted. If yes, you can unstage the whole migration dir with

    git reset HEAD migrations

And then bring them back with

    git checkout -- migrations

Now we only need to tell `merkel` that we want to run down migrations.
Run `git commit`, and in the commit message, add a `merkel down` command with all the migrations that need to be undone.
The command can look like this:

    [merkel down 6e28dcef-16f8-4a81-8783-aedc93043fa4]
    [merkel down bab251c6-4aee-4137-8a83-6e6fcab29cdf]
    [merkel down 43b15c65-2f6d-447d-bbcf-0efe3a34fd10]

Or multi-line like this:

    [
      merkel down
      6e28dcef-16f8-4a81-8783-aedc93043fa4
      bab251c6-4aee-4137-8a83-6e6fcab29cdf
      43b15c65-2f6d-447d-bbcf-0efe3a34fd10
    ]

The order is important here!

#### Reverting a deployment with `git reset`

Let's imagine you are using a `production` branch which always points to a specific commit on `master`, and regurarely
gets updated with `git reset` to point to a new or older commit.
After you `git push --force`, the current `HEAD` will suddenly be _behind_ the last migration run in the database.
`merkel` will detect this automatically, and run the migrations between `HEAD` and the last migrations _down_ and in
reverse order.

### What if I checkout an older commit on my dev machine?

The same applies as for Reverting a deployment with git reset.

### What if I want to change the migration directory?

If you are using a `.merkelrc.json` that has the migration dir specified, `merkel` will use `git show` to get the
migration directory at the time the commit was made.

If not, then this is not possible without using the ability to run old migrations.

## Programatic usage

You can use merkel programatically, for example in your favourite task runner.
API documentation is available [here](http://merkel.surge.sh/).

TypeScript definitions are included.


---------------------------------------------------------------------


> _Wir schaffen das._ – Angela Merkel
