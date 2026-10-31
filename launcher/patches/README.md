# Packaging dependency compatibility

The launcher overrides `minimatch` to `11.0.1` to address
[GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249)
without excluding the advisory from dependency audits.

The installed packaging tools still use older minimatch interfaces. Bun applies
these patches during installation:

- `@electron/asar@3.4.1` and `dir-compare@4.2.0` use the named `minimatch` function.
- `glob@7.2.3` uses the path segment matcher's `pattern` and `test()` interfaces
  in both asynchronous and synchronous directory traversal.

`tests/packaging-dependencies.test.cjs` checks file discovery, ASAR unpack rules,
and directory comparison filters. Remove each patch when its upstream dependency
supports minimatch 11. Keep these checks when updating the packaging dependencies.
