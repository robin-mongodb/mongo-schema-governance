# mongo-schema-governance

A schema governance pipeline for MongoDB that uses Apache Avro as the source of truth. Schemas are defined in `.avsc` files, automatically converted to MongoDB `$jsonSchema` validators, and deployed via GitHub Actions CI/CD.

## How it works

```
schemas/*.avsc  →  avro-to-mongo-validator.js  →  generated/*-validator.json  →  apply-schema.js  →  MongoDB
```

1. Define your schema in Avro (`.avsc`)
2. Push to `main` — GitHub Actions converts and applies all schemas automatically
3. MongoDB enforces strict validation on every insert/update

All collections are in the `schema_governance_demo` database.

## Polymorphic schemas

For collections where document shape varies by type, use a discriminator field + union of records with `x-discriminator-*` metadata:

```json
{
  "name": "accountType",
  "x-discriminator-field": "accountType",
  "x-discriminator-value": "SAVINGS"
}
```

The converter generates a `oneOf` validator where each branch pins the discriminator field to its specific value. See `schemas/bank_account.avsc` for a full example.

## Versioned schemas

Same pattern as polymorphic — use a `version` field as the discriminator. Add `"x-flatten": true` to promote version-specific fields to the top level of the document instead of nesting them. See `schemas/user.avsc` for an example.

## Running locally

```bash
# Install dependencies
npm install

# Convert a schema
node scripts/avro-to-mongo-validator.js schemas/customer.avsc customer

# Apply to MongoDB
MONGODB_URI=<uri> node scripts/apply-schema.js generated/customer-validator.json schema_governance_demo

# Run the schema evolution demo
MONGODB_URI=<uri> node scripts/demo.js
```

## CI/CD

The GitHub Actions workflow (`.github/workflows/apply-schema.yml`) triggers on any push to `main` that modifies `schemas/*.avsc`. It converts all schemas and applies all validators to MongoDB using the `MONGODB_URI` repository secret.

## Important: doubles in mongosh

Fields typed as `double` must use `Double()` in mongosh for whole numbers, otherwise they are stored as `int` and fail validation:

```js
{
  balance: Double(4250);
} // correct
{
  balance: 4250;
} // fails — stored as int
```
