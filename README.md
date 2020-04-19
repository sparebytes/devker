# Devker

CLI to help manage docker-compose database containers for local development.

## Commands

```bash
devker help
devker init <folder>
devker up
devker postgres restore [--db postgres] [--db foobar] [--db etc]
devker postgres dump [--db postgres] [--db foobar] [--db etc]
devker postgres list connections
devker down
devker destroy
... etc
```

## Usage

1. Install devker `npm install --global devker` or `yarn global add devker`
2. Initialize `devker init .`
3. Use `devker up`
4. ???
5. Profit
6. Destroy `devker destroy`
