# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Convert a single Avro schema to a MongoDB validator
node scripts/avro-to-mongo-validator.js schemas/<name>.avsc <collection_name>

# Convert all schemas (mirrors what CI does)
for schema in schemas/*.avsc; do node scripts/avro-to-mongo-validator.js "$schema"; done

# Apply a validator to MongoDB (requires MONGODB_URI env var)
MONGODB_URI=<uri> node scripts/apply-schema.js generated/<name>-validator.json schema_governance_demo

# Run the schema evolution demo
MONGODB_URI=<uri> node scripts/demo.js
```

## Architecture

The pipeline has three stages: **define → convert → deploy**.

### 1. Define (`schemas/*.avsc`)
Avro is the source of truth. Each `.avsc` file maps to one MongoDB collection (snake_case filenames, e.g. `bank_account.avsc` → `bank_account` collection). All schemas target the `schema_governance_demo` database.

**Polymorphic schemas** use a union of named records in a field called `accountDetails`, with two custom `x-` metadata properties on each record variant to express the conditional relationship:
- `"x-discriminator-field"` — the top-level field whose value selects the branch (e.g. `"accountType"`)
- `"x-discriminator-value"` — the value of that field for this branch (e.g. `"SAVINGS"`)

`.avsc` files may contain `//` line comments (non-standard JSON) — the converter strips them before parsing.

### 2. Convert (`scripts/avro-to-mongo-validator.js`)
Reads `.avsc`, outputs `generated/<collection>-validator.json`.

Key logic:
- `convertPolymorphicRecord()` is the entry point. It checks for `x-discriminator-*` metadata on union record variants.
  - **If found**: generates a `oneOf` at the top level of `$jsonSchema`. Each branch inherits shared fields, pins the discriminator field to a single `enum` value, and adds the branch-specific nested fields under `accountDetails`.
  - **If not found**: falls back to `convertRecord()`, which produces a flat schema (used by `customer.avsc`).
- Top-level records (those with a `namespace`) automatically get `_id: {}` in properties to allow MongoDB's auto-generated ID.
- `validationLevel: "strict"` and `validationAction: "error"` are always applied — invalid documents are rejected outright.

### 3. Deploy (`scripts/apply-schema.js`)
Connects to MongoDB via `MONGODB_URI`, creates the collection if it doesn't exist, and runs `db.command(collMod, ...)` to apply the validator.

### CI/CD (`.github/workflows/apply-schema.yml`)
Triggers on pushes to `main` that modify `schemas/*.avsc`. Converts all schemas then applies all generated validators. Uses the `MONGODB_URI` repository secret.

## Avro → MongoDB type mapping

| Avro | MongoDB bsonType |
|------|-----------------|
| string | string |
| int | int |
| long | long |
| float / double | double |
| boolean | bool |
| bytes | binData |
| enum | string + enum constraint |
| record | object |
| array | array |

## Important: double vs int in mongosh

Fields typed as `double` in the schema must use `Double()` in mongosh for whole numbers, otherwise they are stored as `int` and fail validation:

```js
// Wrong — stored as int
{ balance: 4250 }

// Correct
{ balance: Double(4250) }
```
