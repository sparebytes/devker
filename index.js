const { execute } = require("@yarnpkg/shell");
const { Cli, Command } = require("clipanion");
const fs = require("fs");
const { promises: fsp } = fs;
const _path = require("path");
const { Transform } = require("stream");
const uuidv4 = require("uuid/v4");
require("dotenv").config();

// help
class HelpCommand extends Command {
  async execute() {
    this.context.stdout.write(this.cli.usage(null));
  }
}
HelpCommand.addPath("--help");
HelpCommand.addPath("-h");

// BaseCommand
class BaseCommand extends Command {
  cwd = process.cwd();
}
BaseCommand.addOption("cwd", Command.String("--cwd"));

// DockerComposeServiceCommand
class DockerComposeServiceCommand extends BaseCommand {
  cwd = process.cwd();
  service;
}
DockerComposeServiceCommand.addOption("service", Command.String("--service,-s"));

// env init
class EnvInitCommand extends BaseCommand {
  overwrite = false;
  async execute() {
    const envFilepath = _path.resolve(this.cwd, ".env");
    if (!this.overwrite) {
      if (fs.existsSync(envFilepath)) {
        throw new Error(`.env file already exists at "${envFilepath}". Use "--overwite" flag to force.`);
      }
    }
    const envContent = makeEnvFileContent();
    await fsp.writeFile(envFilepath, envContent);
  }
}
EnvInitCommand.addPath(`env`, `init`);
EnvInitCommand.addOption("overwrite", Command.Boolean("--overwrite"));

// bash
class BashCommand extends BaseCommand {
  service;
  command;
  async execute() {
    await bashRun(this.service, this.command[0] || "", { cwd: this.cwd });
  }
}
BashCommand.addPath(`bash`);
BashCommand.addOption("service", Command.String({ required: true }));
BashCommand.addOption("command", Command.Proxy());

// docker-compose
class DockerComposeCommand extends BaseCommand {
  rest;
  async execute() {
    await spawnPromise("docker-compose", this.rest, [], { cwd: this.cwd });
  }
}
DockerComposeCommand.addPath(`docker-compose`);
DockerComposeCommand.addOption("rest", Command.Rest());

// up
class UpCommand extends BaseCommand {
  rest;
  async execute() {
    await spawnPromise("docker-compose", ["up", "-d", ...this.rest], [], { cwd: this.cwd });
  }
}
UpCommand.addPath(`up`);
UpCommand.addOption("rest", Command.Rest());

// down
class DownCommand extends BaseCommand {
  rest;
  async execute() {
    await spawnPromise("docker-compose", ["down", ...this.rest], [], { cwd: this.cwd });
  }
}
DownCommand.addPath(`down`);
DownCommand.addOption("rest", Command.Rest());

// destroy
class DestroyCommand extends BaseCommand {
  rest;
  async execute() {
    await spawnPromise("docker-compose", ["down", "-v", "--remove-orphans", ...this.rest], [], { cwd: this.cwd });
  }
}
DestroyCommand.addPath(`destroy`);
DestroyCommand.addOption("rest", Command.Rest());

// PostgressCommand
class PostgresCommand extends DockerComposeServiceCommand {
  service = "postgres";
}

// postgres ssh
class PostgresSshCommand extends PostgresCommand {
  rest
  async execute() {
    return spawnPromise("docker-compose", ["exec", this.service, "bash", "-l", ...this.rest], [], { cwd: this.cwd });
  }
}
PostgresSshCommand.addOption("rest", Command.Rest());
PostgresSshCommand.addPath(`postgres`, `ssh`);

// postgres psql
class PostgresPsqlCommand extends PostgresCommand {
  rest
  async execute() {
    return spawnPromise("docker-compose", ["exec", this.service, "bash", "-c", `psql`, ...this.rest], [], { cwd: this.cwd });
  }
}
PostgresPsqlCommand.addOption("rest", Command.Rest());
PostgresPsqlCommand.addPath(`postgres`, `psql`);

// postgres restore
class RestoreCommand extends PostgresCommand {
  filename;
  verbose = false;
  quiet = false;
  async execute() {
    const quiet = this.quiet;
    const verbose = this.verbose && !this.quiet;
    const psqlEnv = getPostgresEnv("APP_PSQL_");
    const filename = `${this.filename || "latest"}.sql.gz`;
    const execOptions = {
      cwd: this.cwd,
      stdout: verbose ? this.context.stdout : getStreamSink(),
      stderr: quiet ? getStreamSink() : this.context.stderr,
    };
    console["log"](`Restoring database from ${filename}`);
    const initdbSql = makeInitializeDbScript(psqlEnv);
    if (this.verbose) {
      console["log"]("Executing SQL:");
      for (const line of initdbSql.split(/[\r\n]+/)) {
        console["log"](" ", line);
      }
    }
    await bashRun(this.service, `printf "${escapeBashString(initdbSql)}" | PGDATABASE=postgres psql`, execOptions);
    console["log"](`  ... db ${psqlEnv.dbname} dropped and re-created`);
    await bashRun(this.service, `gunzip -c /root/db-dumps/${filename} | psql`, execOptions);
    console["log"](`  ... ${filename} executed`);
  }
}
RestoreCommand.addPath(`postgres`, `restore`);
RestoreCommand.addOption("filename", Command.String("-f,--filename"));
RestoreCommand.addOption("verbose", Command.Boolean("--verbose"));
RestoreCommand.addOption("quiet", Command.Boolean("-q,--quiet"));

// postgres dump
class DumpCommand extends PostgresCommand {
  filename;
  async execute() {
    const dumpFile = `${this.filename || `dump-${new Date().toISOString().replace(/:/g, "-")}`}.sql.gz`;
    await bashRun(this.service, `pg_dump | gzip > /root/db-dumps/${dumpFile}`, { cwd: this.cwd });
  }
}
DumpCommand.addPath(`postgres`, `dump`);
DumpCommand.addOption("filename", Command.String("-f,--filename"));

// ...
const cli = new Cli({
  binaryLabel: `DbCli`,
  binaryName: `db cli`,
  binaryVersion: `1.0.0`,
});
cli.register(HelpCommand);
cli.register(EnvInitCommand);
cli.register(BashCommand);
cli.register(DockerComposeCommand);
cli.register(UpCommand);
cli.register(DownCommand);
cli.register(DestroyCommand);
cli.register(RestoreCommand);
cli.register(DumpCommand);
cli.register(PostgresSshCommand);
cli.register(PostgresPsqlCommand);
module.exports = { cli };

// utilities

async function bashRun(service, cmd, options) {
  return spawnPromise("docker-compose", ["exec", "-T", service, "bash", "-c", cmd], [], options);
}

async function spawnPromise(command, args1, args2, options) {
  const commandString = commandArrayToString(command, args1);
  const exitCode = await execute(commandString, args2 || [], options);
  if (exitCode !== 0) {
    throw new Error("Command exited with non-zero code of " + exitCode);
  }
}

function escapeCommand(cmd) {
  return escapeBashString(cmd);
}

function commandArrayToString(command, args) {
  const commandParts = [command];
  for (const arg of args) {
    commandParts.push(` "`);
    commandParts.push(escapeCommand(arg));
    commandParts.push(`"`);
  }
  const commandString = commandParts.join("");
  return commandString;
}

function makeEnvFileContent() {
  const key = uuidv4().slice(0, 6);
  return `COMPOSE_FILE=docker-compose.yml
COMPOSE_PROJECT_NAME=my-app-${key}
COMPOSE_PROJECT_DESCRIPTION=My App ${key}
APP_PSQL_PORT=
APP_PSQL_DB=
APP_PSQL_USER=
APP_PSQL_PASSWORD=
APP_REDIS_PORT=
`;
}

function makeInitializeDbScript({ dbname, username, password }) {
  const sql = `
--
-- Kill all connections except this one
--
SELECT pg_terminate_backend(pg_stat_activity.pid) FROM pg_stat_activity WHERE pid <> pg_backend_pid();

--
-- Create "${dbname}" database
--
DROP DATABASE IF EXISTS "${dbname}";
CREATE DATABASE "${dbname}";

--
-- Create "${username}" user/role
--
CREATE ROLE "${username}" WITH PASSWORD '${password}';
ALTER ROLE "${username}" WITH LOGIN;
ALTER ROLE "${username}" WITH SUPERUSER;
ALTER ROLE "${username}" WITH CREATEDB;
ALTER ROLE "${username}" WITH CREATEROLE;
GRANT ALL PRIVILEGES ON SCHEMA public TO "${username}";
GRANT ALL PRIVILEGES ON DATABASE "postgres" TO "${username}";
GRANT ALL PRIVILEGES ON DATABASE "${dbname}" TO "${username}";
`;
  return sql;
}

function getPostgresEnv(prefix) {
  const env = process.env;
  return {
    dbname: env[prefix + "DB"],
    port: env[prefix + "PORT"],
    username: env[prefix + "USER"],
    password: env[prefix + "PASSWORD"],
  };
}

function escapeBashString(input) {
  return input
    .replace(/\\/g, `\\\\`)
    .replace(/"/g, `\\"`)
    .replace(/\r\n/g, `\\n`)
    .replace(/[\r\n]/g, `\\n`);
}

function getStreamSink() {
  var ws = Transform();
  ws._transform = (chunk, enc, next) => {
    next();
  };
  ws._flush = () => {};
  return ws;
}
