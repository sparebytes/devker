import { execute } from "@yarnpkg/shell";
import { capitalCase, constantCase, paramCase, snakeCase } from "change-case";
import { Cli, Command } from "clipanion";
import "core-js/stable";
import * as fs from "fs";
import { promises as fsp } from "fs";
import * as passwordGenerator from "generate-password";
import * as _path from "path";
import { posix } from "path";
import preval from "preval.macro";
import "regenerator-runtime/runtime";
import { Transform } from "stream";
import * as uuidGenerator from "uuid";
import loadEnv from "./load-env";

const devkerVersion = preval`module.exports = require("../package.json").version`;
const envFromFile = loadEnv();

// help
class HelpCommand extends Command {
  @Command.Path("help")
  @Command.Path("-h")
  @Command.Path("--help")
  async execute() {
    this.context.stdout.write(this.cli.usage(null));
  }
}

// version
class VersionCommand extends Command {
  @Command.Path("version")
  async execute() {
    this.context.stdout.write(devkerVersion + "\n");
  }
}

// print env
class PrintEnvCommand extends Command {
  @Command.Path("print", "env")
  async execute() {
    const parsed = envFromFile.parsed;
    for (const k in parsed) {
      this.context.stdout.write(`${k}=${parsed[k]}\n`);
    }
  }
}

// generate password
class GeneratePasswordCommand extends Command {
  @Command.String("-c,--count")
  count = 1;

  @Command.String("-l,--length")
  length = 10;

  @Command.String("-e,--exclude")
  exclude = "";

  @Command.Rest()
  flags = [];

  @Command.Path("generate", "password")
  async execute() {
    const flags = new Set(["numbers", "uppercase"]);
    for (const flag of this.flags) {
      if (flag.startsWith("!")) {
        flags.delete(flag.slice(1));
      } else {
        flags.add(flag);
      }
    }
    const passwords = passwordGenerator.generateMultiple(parseInt(this.count), {
      length: parseInt(this.length),
      numbers: flags.has("numbers"),
      symbols: flags.has("symbols"),
      lowercase: flags.has("lowercase"),
      uppercase: flags.has("uppercase"),
      excludeSimilarCharacters: !flags.has("similarCharacters"),
      exclude: flags.has("exclude"),
      strict: flags.has("strict"),
    });
    for (const password of passwords) {
      this.context.stdout.write(password + "\n");
    }
  }
}

// generate password
class GenerateUuidCommand extends Command {
  @Command.String("-c,--count")
  count = 1;

  @Command.Rest()
  rest = [];

  @Command.Path("generate", "uuid")
  async execute() {
    const version = this.rest[0] || "v4";
    const uuidGen = uuidGenerator[version];
    if (uuidGen == null) {
      console.error(`"${version}" is not a valid uuid version`);
      return 1;
    }
    for (let i = 0; i < this.count; i++) {
      this.context.stdout.write(uuidGen() + "\n");
    }
  }
}

// BaseCommand
class BaseCommand extends Command {
  @Command.String("--cwd")
  cwd = process.cwd();
}

// ssh
class SshCommand extends BaseCommand {
  @Command.String({ required: true })
  service;

  @Command.Boolean("--bash")
  bash = false;

  @Command.Rest()
  rest;

  @Command.Path(`ssh`)
  async execute() {
    const shellLogin = this.bash ? ["bash", "-l"] : ["sh"];
    return spawnPromise("docker-compose", ["exec", this.service, ...shellLogin, ...this.rest], [], { cwd: this.cwd });
  }
}

// DockerComposeServiceCommand
class DockerComposeServiceCommand extends BaseCommand {
  @Command.String("-s,--service")
  service;
}

// env init
class InitCommand extends BaseCommand {
  @Command.String({ required: true })
  dir = undefined;

  @Command.Boolean("-n,--name")
  name = "My App";

  @Command.Boolean("--overwrite")
  overwrite = false;

  @Command.Path(`init`)
  async execute() {
    if (!this.dir) {
      throw new Error("dir argument is required");
    }
    const rootDir = _path.resolve(this.cwd, this.dir);
    await fsp.mkdir(rootDir, { recursive: true });
    const files = await makeInitFileContent({ name: this.name });
    let errored = false;
    for (const relPath in files) {
      const contents = files[relPath];
      const filepath = _path.resolve(rootDir, relPath);
      try {
        await fsp.mkdir(_path.dirname(filepath), { recursive: true });
        if (!this.overwrite) {
          if (fs.existsSync(filepath)) {
            errored = true;
            console.error(`Skipping: ${filepath}\n  "${relPath}" already exists. Use "--overwite" flag to force.`);
            continue;
          }
        }
        await fsp.writeFile(filepath, contents);
        console["log"]("Wrote:", filepath);
      } catch (error) {
        errored = true;
        console.error("Error while writing file:", filepath);
        console.error(error);
      }
    }
    return errored ? 1 : 0;
  }
}

// bash
class BashCommand extends BaseCommand {
  @Command.String({ required: true })
  service;

  @Command.Proxy()
  command;

  @Command.Path(`bash`)
  async execute() {
    await bashRun(this.service, this.command[0] || "", { cwd: this.cwd });
  }
}

// docker-compose
class DockerComposeCommand extends BaseCommand {
  @Command.Rest()
  rest;

  @Command.Path(`docker-compose`)
  async execute() {
    await spawnPromise("docker-compose", this.rest, [], { cwd: this.cwd });
  }
}

// up
class UpCommand extends BaseCommand {
  @Command.Rest()
  rest;

  @Command.Path(`up`)
  async execute() {
    await spawnPromise("docker-compose", ["up", "-d", ...this.rest], [], { cwd: this.cwd });
  }
}

// down
class DownCommand extends BaseCommand {
  @Command.Rest()
  rest;

  @Command.Path(`down`)
  async execute() {
    await spawnPromise("docker-compose", ["down", ...this.rest], [], { cwd: this.cwd });
  }
}

// destroy
class DestroyCommand extends BaseCommand {
  @Command.Rest()
  rest;

  @Command.Path(`destroy`)
  async execute() {
    await spawnPromise("docker-compose", ["down", "-v", "--remove-orphans", ...this.rest], [], { cwd: this.cwd });
  }
}

// PostgressCommand
class PostgresCommand extends DockerComposeServiceCommand {
  @Command.String("-s,--service")
  service = "postgres";

  @Command.String("--env-prefix")
  _envVarPrefix = "";

  get envVarPrefix() {
    return this._envVarPrefix || constantCase(`DEVKER_${this.service}`) + "_";
  }
  get postgresEnv() {
    return getPostgresEnv(this.envVarPrefix);
  }
  findMatchingConnections(options) {
    const psqlEnv = options.postgresEnv || this.postgresEnv;
    const dbnames = new Set(options.filters.length > 0 ? options.filters : psqlEnv.connections.map((c) => c.dbname));
    const matchingConnections = Array.from(dbnames.values()).map((dbname) => {
      const connection = psqlEnv.connections.find((c) => c.dbname === dbname);
      if (connection == null) {
        throw new Error(`Unable to find connection with db "${dbname}"`);
      }
      return connection;
    });
    return matchingConnections;
  }
}

// postgres psql
class PostgresPsqlCommand extends PostgresCommand {
  @Command.String("-U,--username")
  username;

  @Command.Rest()
  rest;

  @Command.Path(`postgres`, `psql`)
  async execute() {
    const psqlEnv = this.postgresEnv;
    const username = this.username || psqlEnv.super.username || "postgres";
    return spawnPromise(
      "docker-compose",
      ["exec", this.service, "bash", "-c", commandArrayToString("psql", ["-U", username, ...this.rest])],
      [],
      { cwd: this.cwd },
    );
  }
}

// postgres restore
class PostgresRestoreCommand extends PostgresCommand {
  @Command.Array("-d,--db")
  dbnames = [];

  @Command.String("-f,--filename")
  filename;

  @Command.String("-u,--username")
  username;

  @Command.Boolean("--verbose")
  verbose = false;

  @Command.Boolean("-q,--quiet")
  quiet = false;

  @Command.Boolean("--no-gz")
  noGzip = false;

  @Command.Path(`postgres`, `restore`)
  async execute() {
    const quiet = this.quiet;
    const verbose = this.verbose && !this.quiet;
    const execOptions = {
      cwd: this.cwd,
      stdout: verbose ? this.context.stdout : getStreamSink(),
      stderr: quiet ? getStreamSink() : this.context.stderr,
    };
    const postgresEnv = this.postgresEnv;
    const superuser = postgresEnv.super.username;
    const matchingConnections = this.findMatchingConnections({ filters: this.dbnames, postgresEnv });
    let errored = false;
    await useTemporaryDb(this.service, superuser, execOptions, async (tmpdb, execSql) => {
      for (const connection of matchingConnections) {
        try {
          const filename = `${connection.dbname}/${this.filename || "latest"}.sql${this.noGzip ? "" : ".gz"}`;
          console["log"]("Droping and Recreating Database:", connection.dbname);
          await execSql(
            `${killConnectionsSql(connection.dbname)};\ndrop database if exists "${connection.dbname}";create database "${
              connection.dbname
            }";`,
            {
              ...execOptions,
              stdout: getStreamSink(),
              stderr: getStreamSink(),
            },
          );
          if (connection.username) {
            console["log"]("Creating Role:", connection.username);
            const initdbSql = initializeRoleSql(connection);
            if (this.verbose) {
              console["log"]("Executing SQL:");
              console["log"](initdbSql);
            }
            await execSql(initdbSql);
          } else {
            console.warn("Creating Role: Skipped becuase username is empty!");
          }
          console["log"](`Restoring database from ${filename}`);
          const readCommand = this.noGzip ? `cat /root/db-dumps/${filename}` : `gunzip -c /root/db-dumps/${filename}`;
          await bashRun(this.service, `${readCommand} | psql -U ${superuser} --dbname ${connection.dbname}`, execOptions);
          console["log"](`  ... ${filename} executed`);
        } catch (error) {
          errored = true;
          console.error(error);
          console.error("Error while restoring database:", connection.dbname);
        }
      }
    });
    return errored ? 1 : 0;
  }
}

// postgres dump
class PostgresDumpCommand extends PostgresCommand {
  @Command.Array("-d,--db")
  dbnames = [];

  @Command.String("-f,--filename")
  filename;

  @Command.Boolean("--no-gz")
  noGzip = false;

  @Command.Path(`postgres`, `dump`)
  async execute() {
    const postgresEnv = this.postgresEnv;
    const superuser = postgresEnv.super.username;
    const matchingConnections = this.findMatchingConnections({ filters: this.dbnames, postgresEnv });
    let errored = false;
    for (const connection of matchingConnections) {
      try {
        console["log"]("Dumping Database:", connection.dbname);
        const name = this.filename || `dump-${new Date().toISOString().replace(/:/g, "-")}`;
        const dumpPath = posix.normalize(`/root/db-dumps/${connection.dbname}/${name}.sql${this.noGzip ? "" : ".gz"}`);
        const dumpDir = posix.dirname(dumpPath);
        await bashRun(this.service, `mkdir -p ${dumpDir}`, { cwd: this.cwd });
        const sqlPipe = this.noGzip ? "" : "| gzip";
        await bashRun(this.service, `pg_dump -U ${superuser} --dbname ${connection.dbname} ${sqlPipe} > ${dumpPath}`, {
          cwd: this.cwd,
        });
        console["log"]("  ", dumpPath);
      } catch (error) {
        errored = true;
        console.error(error);
        console.error("Error while dumping database:", connection.dbname);
      }
    }
    return errored ? 1 : 0;
  }
}

// postgres list connections
class PostgresListConnectionCommand extends PostgresCommand {
  @Command.Path(`postgres`, `list`, `connections`)
  async execute() {
    for (const connection of this.postgresEnv.connections) {
      console["log"](
        `postgresql://${connection.username}:${connection.password}@${connection.host}:${connection.port}/${connection.dbname}`,
      );
    }
  }
}

// postgres kill connections
class PostgresKillConnectionCommand extends PostgresCommand {
  @Command.Path(`postgres`, `kill`, `connections`)
  async execute() {
    await postgresExecuteSql(this.service, killConnectionsSql(), this.postgresEnv.super.username, { cwd: this.cwd });
  }
}

// ...
const cli = new Cli({
  binaryLabel: `Devker`,
  binaryName: `devker`,
  binaryVersion: devkerVersion,
});
cli.register(HelpCommand);
cli.register(VersionCommand);
cli.register(PrintEnvCommand);
cli.register(GeneratePasswordCommand);
cli.register(GenerateUuidCommand);
cli.register(SshCommand);
cli.register(InitCommand);
cli.register(BashCommand);
cli.register(DockerComposeCommand);
cli.register(UpCommand);
cli.register(DownCommand);
cli.register(DestroyCommand);
cli.register(PostgresRestoreCommand);
cli.register(PostgresDumpCommand);
cli.register(PostgresPsqlCommand);
cli.register(PostgresListConnectionCommand);
cli.register(PostgresKillConnectionCommand);
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

async function makeInitFileContent(options) {
  const description = capitalCase(options.name);
  const name = paramCase(options.name);
  const exampleUser = snakeCase(options.name);
  const key = passwordGenerator.generate({
    length: 6,
    numbers: true,
    lowercase: true,
    excludeSimilarCharacters: true,
  });
  const [superPassword, examplePassword] = passwordGenerator.generateMultiple(2, {
    length: 10,
    numbers: true,
    symbols: false,
    lowercase: false,
    uppercase: true,
    excludeSimilarCharacters: true,
  });
  const dockerComposeContent = await fsp
    .readFile(_path.resolve(__dirname, "docker-compose.template.yml"))
    .then((b) => b.toString())
    .catch((e) => `Error reading docker-compose.template.yml. ` + (e || {}).message || "");
  return {
    ".gitignore": `/db-dumps
!/db-dumps/.gitkeep
.env.local
.env.*.local
`,
    ".env": `COMPOSE_FILE=docker-compose.yml
COMPOSE_PROJECT_NAME=${name}-${key}
COMPOSE_PROJECT_DESCRIPTION=${description} ${key}
DEVKER_POSTGRES_DUMP_FOLDER=./db-dumps
DEVKER_POSTGRES_PORT=5432
DEVKER_POSTGRES_SUPER_PASSWORD=${superPassword}
# DEVKER_POSTGRES_CONNECTIONS=["${exampleUser}:${examplePassword}@localhost/${exampleUser}"]
`,
    ".env.local": `# Anything you would like to override on your personal machine goes here.
`,
    "docker-compose.yml": dockerComposeContent,
    "db-dumps/.gitkeep": "",
  };
}

function initializeRoleSql({ dbname, username, password }) {
  const passwordSql = password
    ? `
ALTER ROLE "${username}" WITH PASSWORD '${password}';
ALTER ROLE "${username}" WITH LOGIN;`
    : "";
  const sql = `
--
-- Create "${username}" user/role
--
DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${username}') THEN
  CREATE ROLE "${username}";
END IF; END $$;
${passwordSql}
ALTER ROLE "${username}" WITH CREATEDB;
ALTER ROLE "${username}" WITH CREATEROLE;
GRANT ALL PRIVILEGES ON DATABASE "${dbname}" TO "${username}";
`;
  // ALTER ROLE "${username}" WITH SUPERUSER;
  // GRANT ALL PRIVILEGES ON SCHEMA public TO "${username}";
  // GRANT ALL PRIVILEGES ON DATABASE "postgres" TO "${username}";
  return sql;
}

function getPostgresEnv(prefix) {
  const env = process.env;
  const superPrefix = prefix + "SUPER_";
  const port = env[prefix + "PORT"];
  const _super = {
    dbname: env[superPrefix + "DB"] || "postgres",
    username: env[superPrefix + "USER"] || "postgres",
    password: env[superPrefix + "PASSWORD"],
    host: "localhost",
    port: port,
  };
  const connections = [
    _super,
    ...JSON.parse(env[prefix + "connections"] || "[]").map((connection) => {
      const parsed = parseConnectionString(connection);
      return {
        dbname: parsed.dbname,
        username: parsed.username,
        password: parsed.password,
        host: parsed.host || "localhost",
        port: parsed.port || port,
      };
    }),
  ];
  return { port, super: _super, connections };
}

const parseConnectionStringRegex = /^(?:.*?\/\/)?(?:(?<username>[^:@]*)?(?::(?<password>[^@]*))?@)?(?<host>[^:/]+)(?::(?<port>\d+))?\/(?<dbname>[^?]+)/;
function parseConnectionString(cs) {
  const parts = parseConnectionStringRegex.exec(cs);
  if (parts == null) {
    throw new Error("Unable to parse connection string:" + cs);
  }
  return parts.groups;
}

function escapeBashString(input) {
  return input
    .replace(/\\/g, `\\\\`)
    .replace(/"/g, `\\"`)
    .replace(/\$/g, `\\$`)
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

async function postgresExecuteSql(service, superuser, dbname, sql, execOptions) {
  const escapedSql = escapeBashString(sql);
  await bashRun(service, `printf "${escapedSql}" | psql -U ${superuser || "postgres"} --dbname ${dbname}`, execOptions);
}

async function useTemporaryDb(service, superuser, execOptions, callback) {
  const quietExecOptions = {
    ...execOptions,
    stdout: getStreamSink(),
    stderr: getStreamSink(),
  };
  const tmpDbname = `tmpdb_${uuidGenerator.v4().slice(0, 8)}`;
  const execSql = async (sql, _execOptions) => {
    _execOptions = { execOptions, ..._execOptions };
    await postgresExecuteSql(service, superuser, tmpDbname, sql, _execOptions);
  };
  try {
    await bashRun(service, `createdb -U ${superuser} ${tmpDbname}`, quietExecOptions);
    await callback(tmpDbname, execSql);
  } finally {
    await bashRun(service, `dropdb -U ${superuser} --if-exists ${tmpDbname}`, quietExecOptions);
  }
}

function killConnectionsSql(dbname) {
  const dbnameClause = dbname ? ` AND datname = '${dbname}' ` : "";
  return `
-- Kill all connections except this one
SELECT pg_terminate_backend(pg_stat_activity.pid) FROM pg_stat_activity WHERE pid <> pg_backend_pid() ${dbnameClause};
`;
}
