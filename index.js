const envFromFile = require("dotenv-expand")(require("dotenv-flow").config());
const { execute } = require("@yarnpkg/shell");
const { Cli, Command } = require("clipanion");
const fs = require("fs");
const { promises: fsp } = fs;
const _path = require("path");
const { posix } = _path;
const { Transform } = require("stream");
const { capitalCase, constantCase, paramCase, snakeCase } = require("change-case");
const uuidGenerator = require("uuid");
const passwordGenerator = require("generate-password");

const devkerVersion = require("./package.json").version;

// help
class HelpCommand extends Command {
  async execute() {
    this.context.stdout.write(this.cli.usage(null));
  }
}
HelpCommand.addPath("--help");
HelpCommand.addPath("-h");

// version
class VersionCommand extends Command {
  async execute() {
    this.context.stdout.write(devkerVersion + "\n");
  }
}
VersionCommand.addPath("version");

// print env
class PrintEnvCommand extends Command {
  async execute() {
    const parsed = envFromFile.parsed;
    for (const k in parsed) {
      this.context.stdout.write(`${k}=${parsed[k]}\n`);
    }
  }
}
PrintEnvCommand.addPath("print", "env");

// generate password
class GeneratePasswordCommand extends Command {
  count = 1;
  length = 10;
  exclude = "";
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
GeneratePasswordCommand.addPath("generate", "password");
GeneratePasswordCommand.addOption("count", Command.String("-c,--count"));
GeneratePasswordCommand.addOption("length", Command.String("-l,--length"));
GeneratePasswordCommand.addOption("exclude", Command.String("-e,--exclude"));
GeneratePasswordCommand.addOption("flags", Command.Rest());

// generate password
class GenerateUuidCommand extends Command {
  count = 1;
  rest = [];
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
GenerateUuidCommand.addPath("generate", "uuid");
GenerateUuidCommand.addOption("count", Command.String("-c,--count"));
GenerateUuidCommand.addOption("rest", Command.Rest());

// BaseCommand
class BaseCommand extends Command {
  cwd = process.cwd();
}
BaseCommand.addOption("cwd", Command.String("--cwd"));

// ssh
class SshCommand extends BaseCommand {
  service;
  rest;
  async execute() {
    return spawnPromise("docker-compose", ["exec", this.service, "bash", "-l", ...this.rest], [], { cwd: this.cwd });
  }
}
SshCommand.addPath(`ssh`);
SshCommand.addOption("service", Command.String({ required: true }));
SshCommand.addOption("rest", Command.Rest());

// DockerComposeServiceCommand
class DockerComposeServiceCommand extends BaseCommand {
  service;
}
DockerComposeServiceCommand.addOption("service", Command.String("-s,--service"));

// env init
class InitCommand extends BaseCommand {
  dir = undefined;
  name = "My App";
  overwrite = false;
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
      try {
        const filepath = _path.resolve(rootDir, relPath);
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
        console.error("Error while writing file:", filePath);
        console.error(error);
      }
    }
    return errored ? 1 : 0;
  }
}
InitCommand.addPath(`init`);
InitCommand.addOption("dir", Command.String({ required: true }));
InitCommand.addOption("name", Command.Boolean("-n,--name"));
InitCommand.addOption("overwrite", Command.Boolean("--overwrite"));

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
PostgresCommand.addOption("service", Command.String("-s,--service"));
PostgresCommand.addOption("envPrefix", Command.String("--env-prefix"));

// postgres psql
class PostgresPsqlCommand extends PostgresCommand {
  username;
  rest;
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
PostgresPsqlCommand.addOption("username", Command.String("-U,--username"));
PostgresPsqlCommand.addOption("rest", Command.Rest());
PostgresPsqlCommand.addPath(`postgres`, `psql`);

// postgres restore
class PostgresRestoreCommand extends PostgresCommand {
  dbnames = [];
  filename;
  verbose = false;
  quiet = false;
  noGzip = false;
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
PostgresRestoreCommand.addPath(`postgres`, `restore`);
PostgresRestoreCommand.addOption("dbnames", Command.Array("-d,--db"));
PostgresRestoreCommand.addOption("username", Command.String("-u,--username"));
PostgresRestoreCommand.addOption("filename", Command.String("-f,--filename"));
PostgresRestoreCommand.addOption("verbose", Command.Boolean("--verbose"));
PostgresRestoreCommand.addOption("quiet", Command.Boolean("-q,--quiet"));
PostgresRestoreCommand.addOption("noGzip", Command.Boolean("--no-gz"));

// postgres dump
class PostgresDumpCommand extends PostgresCommand {
  dbnames = [];
  filename;
  noGzip = false;
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
PostgresDumpCommand.addPath(`postgres`, `dump`);
PostgresDumpCommand.addOption("dbnames", Command.Array("-d,--db"));
PostgresDumpCommand.addOption("filename", Command.String("-f,--filename"));
PostgresDumpCommand.addOption("noGzip", Command.Boolean("--no-gz"));

// postgres list connections
class PostgresListConnectionCommand extends PostgresCommand {
  async execute() {
    for (const connection of this.postgresEnv.connections) {
      console["log"](
        `postgresql://${connection.username}:${connection.password}@${connection.host}:${connection.port}/${connection.dbname}`,
      );
    }
  }
}
PostgresListConnectionCommand.addPath(`postgres`, `list`, `connections`);

// postgres kill connections
class PostgresKillConnectionCommand extends PostgresCommand {
  async execute() {
    await postgresExecuteSql(this.service, killConnectionsSql(), this.postgresEnv.super.username, { cwd: this.cwd });
  }
}
PostgresKillConnectionCommand.addPath(`postgres`, `kill`, `connections`);

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

const parseConnectionStringRegex = /^(?:.*?\/\/)?(?:(?<username>[^:@]*)?(?:\:(?<password>[^@]*))?@)?(?<host>[^\:/]+)(?:\:(?<port>\d+))?\/(?<dbname>[^\?]+)/;
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
    await postgresExecuteSql(service, superuser, tmpDbname, sql, execOptions);
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
