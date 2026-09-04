# Archlang syntax grammar example

This folder extension adds a bounded, data-only TextMate grammar for `.arch` files. Run it against a
repository containing Archlang input:

```bash
hunk --extension ./examples/extensions/archlang-syntax diff
```

The grammar deliberately uses only local repository includes. Hunk validates, copies, freezes, and
sends the data to its killable highlight worker; it never retains an extension loader callback.
