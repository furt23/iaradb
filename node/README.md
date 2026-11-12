# iara

The Iara query engine for Node.js: a lazy DataFrame API and SQL, on Rust and Apache Arrow. Documentation: `apps/docs/src/content/docs/typescript.md`.

Build and test from the repository root:

```bash
pnpm --dir node --ignore-workspace install
pnpm --dir node --ignore-workspace run build:native
pnpm --dir node --ignore-workspace run test
```

This folder is outside the pnpm workspace, like `python/`, so the Studio's install and Docker builds don't need Rust.
