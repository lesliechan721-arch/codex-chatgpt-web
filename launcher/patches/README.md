# Packaging dependency compatibility

The launcher overrides only `minimatch@>=7.0.0 <11.0.1` to `11.0.5`.
This keeps modern consumers on the upstream security update while allowing legacy
packaging tools to use the minimatch interfaces declared by their dependencies.

`@electron/asar@3.4.1`, `glob@7.2.3`, and `dir-compare@4.2.0` use minimatch 3.
Their original callable export and path segment matcher remain available, so no
compatibility patches or `patchedDependencies` entries are needed.

`tests/packaging-dependencies.test.cjs` checks file discovery, ASAR unpack rules,
and directory comparison filters against the installed packages. Keep these
behavior checks when updating packaging dependencies or the override range.
