# @ctxo/lang-java

Java language plugin for [Ctxo](https://github.com/alperhankendi/Ctxo). Gives AI coding
assistants dependency-aware context for Java codebases via two tiers.

## Tiers

| Tier | Engine | Emits | When active |
|---|---|---|---|
| **Syntax** (baseline) | `tree-sitter-java` | symbols, `imports`/`extends`/`implements` edges, cyclomatic complexity, annotations (string values) | always |
| **Full** | Eclipse JDT Core (`ctxo-jdt-analyzer` JAR) | resolved `calls`/`uses` edges, cross-file symbol IDs, generics, partial bindings, annotations (constant values), SQL edges at known call sites | JRE 11+ present **and** analyzer JAR acquired (opt-in) |

The syntax tier ships in the package and needs zero setup. The full tier requires a Java
runtime (JRE 11+) and the analyzer JAR; without them the plugin degrades cleanly to the
syntax tier — the index never blocks.

## Install

```bash
ctxo install java          # adds @ctxo/lang-java to your project
```

Detection is automatic: a `pom.xml`, `build.gradle`, `build.gradle.kts`, or `.java` files
flag the project as Java.

## Full tier

The full tier uses Eclipse JDT Core, packaged as prebuilt JAR variants inside the
`@ctxo/lang-java-analyzer` companion package (~15 MB total).
Per [ADR-014](../../docs/architecture/ADR/adr-014-java-full-tier-via-eclipse-jdt.md):

### Automatic JAR selection — no configuration needed

The plugin detects your JRE version at runtime and selects the matching JAR automatically:

| JRE on PATH | JAR selected | JDT Core | Analyzes source levels |
|---|---|---|---|
| **11 – 16** | `ctxo-jdt-analyzer-11.jar` | 3.33.0 (JavaSE-11) | Java 8 – 19 |
| **17+** | `ctxo-jdt-analyzer-17.jar` | 3.39.0 (JavaSE-17) | Java 8 – 21 |
| < 11 or absent | — | — | syntax tier only |

The analyzed **source level** is always independent of the running JRE — both JARs can parse
Java source files written in any version within their supported range.

- **Distribution:** JARs are **prebuilt artifacts**, not built on your machine. Acquired
  **opt-in** (never a silent download) and verified by SHA-256.
- **Local override:** point the plugin at a specific JAR with
  `CTXO_JDT_ANALYZER_JAR` (absolute path). Useful for development, air-gapped setups, and CI.
- **Java location:** the plugin resolves `java` via `CTXO_JAVA_HOME` → `JAVA_HOME` → `PATH`.

To switch between Java 11 and Java 17 full tier, set `CTXO_JAVA_HOME` to the desired JRE:

```bash
CTXO_JAVA_HOME=/path/to/jre11 ctxo index   # → java11 JAR selected
CTXO_JAVA_HOME=/path/to/jre17 ctxo index   # → java17 JAR selected
```

### Classpath resolution

For accurate binding resolution the analyzer locates dependency JARs in order: explicit
override -> IDE metadata (`.classpath`, `.idea/libraries`) -> local repository scan
(`~/.m2`, Gradle cache, parsed from `pom.xml` / `build.gradle`) -> empty (intra-file
bindings only). Build tools (`mvn`/`gradle`) are **never executed** by default.

## Symbol & edge mapping

Java constructs map onto Ctxo's symbol/edge kinds without extending the plugin API:
`enum` -> `type`, `record` -> `class`, `@interface` -> `interface`, constructors -> `method`,
fields -> `variable`.

## Annotations

Annotations on types, methods and fields become symbol annotations, always on, with the Ctxo caps
(20 per symbol, 10 positional and 10 named entries, 200 characters per value):

- `name` is the simple name; the `value` member (shorthand or explicit) goes to `args`, the other
  members to `named`. A member named `type` is dropped (`named.type` is reserved).
- Full tier: declared values only, no defaults. Strings as they are, numbers through
  `String.valueOf`, `true`/`false`, enum constants as `Type.MEMBER`, class literals as the
  qualified name; arrays flattened in `args` and joined with `,` in `named`; nested annotations and
  nulls skipped. Annotations survive a missing classpath (the syntax with constant evaluation).
- Syntax tier: string literals and string arrays only (`nullable = false` appears only in the full
  tier); constants and concatenation are not evaluated.

`@Entity @Table(name = "loans")` on a class gives
`[{ name: 'Entity' }, { name: 'Table', named: { name: 'loans' } }]`.

## Test sources

The JDT analyzer walks the whole project root except build folders, so test methods under
`src/test/java` are method symbols with their annotations. A JUnit `@Test` gives the annotation
`Test`, which marks the file as a test file for the contexts view and `find_dead_code`, wherever it
sits.

## SQL at call sites

With [`@ctxo/lang-sql`](../lang-sql) installed (`capabilities.sqlCallSites`) and the full tier
active, the analyzer reports constant SQL at known call sites and the plugin turns it into
`reads`, `writes` and `executes` edges from the enclosing method or constructor, through
[`@ctxo/sql-extract`](../sql-extract):

| API | SQL text |
|---|---|
| JDBC `Connection.prepareStatement`, `prepareCall`; `Statement.execute*` | first argument |
| Spring `JdbcTemplate`, `NamedParameterJdbcTemplate` and their `*Operations` interfaces (`query*`, `update`, `batchUpdate`, `execute`) | first `String` argument; every argument of an all-`String` `batchUpdate` |
| `EntityManager.createNativeQuery` (`javax` and `jakarta`) | first argument |
| Spring Data `@Query(value = ..., nativeQuery = true)` | `value` |
| MyBatis `@Select`, `@Insert`, `@Update`, `@Delete` | `value`, array elements joined with a space |

- Constants only: literals, `static final` constants, concatenation and text blocks (JDT constant
  evaluation). A JDBC escape `{call name(...)}` gives an `executes` edge.
- The receiver matches by its static type, the binding's declaring class or any supertype; without
  dependency JARs, by the declared type through the imports. Without a binding, subclass receivers
  (`LoanJdbc extends JdbcTemplate`), `super.update(...)` and array literals in `batchUpdate` are
  missed.
- MyBatis `<script>` and `${}` texts pass through as written. JPQL and Spring Data derived queries
  are not covered.
- The tree-sitter tier gives no SQL edges, and without `@ctxo/lang-sql` there are none.

## License

MIT
