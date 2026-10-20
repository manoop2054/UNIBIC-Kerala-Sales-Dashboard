# Authorization core tests

This folder contains an isolated, pure authorization helper and Node's built-in tests.

Run from this directory with Node 20+:

```sh
node --test authorization-core.test.js
```

The tests cover resource separation, Area/Anchor Zone boundaries, action permissions, inactive employees and fail-closed missing scope.

**Important:** passing these tests does not mean production is protected. The helper is not yet connected to authentication, persistent D1 storage, or any live API. Before deployment, server routes must load permission and scope records from trusted storage and enforce checks on every relevant API, report, chatbot, and export path.
