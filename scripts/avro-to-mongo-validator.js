const fs = require("fs");
const path = require("path");

// ─── Avro primitive type → MongoDB bsonType ───────────────────────────────────
function avroPrimitiveToBsonType(avroType) {
  const mapping = {
    string: "string",
    int: "int",
    long: "long",
    float: "double",   // MongoDB has no "float" — uses double
    double: "double",
    boolean: "bool",   // Avro says "boolean", MongoDB says "bool"
    bytes: "binData",
    null: "null",
  };
  return mapping[avroType] || "string";
}

// ─── Convert a single Avro field type to a MongoDB property schema ────────────
function convertAvroType(avroType) {
  // Simple primitive: "string", "int", etc.
  if (typeof avroType === "string") {
    return { bsonType: avroPrimitiveToBsonType(avroType) };
  }

  // Union type: ["null", "string"] = optional field, ["RecordA", "RecordB"] = polymorphic
  if (Array.isArray(avroType)) {
    const nonNullTypes = avroType.filter((t) => t !== "null");
    if (nonNullTypes.length === 1) {
      return convertAvroType(nonNullTypes[0]);
    }
    // Multi-type union without discriminator metadata — fall back to anyOf
    return { anyOf: nonNullTypes.map((t) => convertAvroType(t)) };
  }

  // Complex type object
  if (typeof avroType === "object") {
    if (avroType.type === "enum") {
      return {
        bsonType: "string",
        enum: avroType.symbols,
        description: `Allowed values: ${avroType.symbols.join(", ")}`,
      };
    }
    if (avroType.type === "array") {
      return { bsonType: "array", items: convertAvroType(avroType.items) };
    }
    if (avroType.type === "record") {
      return convertRecord(avroType);
    }
    if (avroType.type === "map") {
      return { bsonType: "object" };
    }
  }

  return { bsonType: "string" };
}

// ─── Convert an Avro record to a MongoDB $jsonSchema object ──────────────────
function convertRecord(avroSchema) {
  const properties = {};
  const required = [];

  for (const field of avroSchema.fields) {
    const isOptional = Array.isArray(field.type) && field.type.includes("null");
    if (!isOptional) {
      required.push(field.name);
    }

    const property = convertAvroType(field.type);
    if (field.doc) {
      property.description = field.doc;
    }
    properties[field.name] = property;
  }

  const schema = {
    bsonType: "object",
    required: required,
    properties: properties,
    additionalProperties: false,
  };

  // Top-level records need to allow MongoDB's auto-generated _id field
  if (avroSchema.namespace) {
    schema.properties._id = {};
  }

  if (avroSchema.doc) {
    schema.title = avroSchema.doc;
  }

  return schema;
}

// ─── Discriminator detection ──────────────────────────────────────────────────
// Returns the record variants that carry x-discriminator-* metadata, or null
// if this union is not a discriminated polymorphic union.
function getDiscriminatorBranches(fieldType) {
  if (!Array.isArray(fieldType)) return null;
  const nonNull = fieldType.filter((t) => t !== "null");
  const branches = nonNull.filter(
    (t) => typeof t === "object" && t["x-discriminator-field"]
  );
  return branches.length > 0 ? branches : null;
}

// ─── Convert a polymorphic Avro record to a MongoDB oneOf schema ──────────────
//
// When a field's union type contains records annotated with x-discriminator-field
// and x-discriminator-value, the converter promotes the entire top-level schema
// into a oneOf, where each branch:
//   1. Inherits all shared fields (common to every document)
//   2. Pins the discriminator field (e.g. accountType) to the branch's specific value
//   3. Defines the branch-specific nested fields under the polymorphic field name
//
// This matches the MongoDB polymorphic validation pattern described at:
// https://www.mongodb.com/docs/manual/core/schema-validation/specify-validation-polymorphic-collections/
//
function convertPolymorphicRecord(avroSchema) {
  // ── Step 1: Find the field whose union carries discriminator metadata ────────
  let polymorphicFieldName = null;   // field name holding the union, e.g. "accountDetails"
  let discriminatorFieldName = null; // the sibling field acting as discriminator, e.g. "accountType"
  let branches = null;

  for (const field of avroSchema.fields) {
    const branchRecords = getDiscriminatorBranches(field.type);
    if (branchRecords) {
      polymorphicFieldName = field.name;
      branches = branchRecords;
      discriminatorFieldName = branchRecords[0]["x-discriminator-field"];
      break;
    }
  }

  // No discriminator found — fall back to a standard record conversion
  if (!branches) {
    return convertRecord(avroSchema);
  }

  // ── Step 2: Build shared properties ─────────────────────────────────────────
  // These are the fields common to every document regardless of account type.
  // We exclude:
  //   - the polymorphic field (accountDetails) — handled per branch below
  //   - the discriminator field (accountType)  — pinned to a specific value per branch
  const sharedProperties = {};
  const sharedRequired = [];

  // Always allow MongoDB's auto-generated _id at the top level
  if (avroSchema.namespace) {
    sharedProperties._id = {};
  }

  for (const field of avroSchema.fields) {
    if (field.name === polymorphicFieldName) continue;  // handled per branch
    if (field.name === discriminatorFieldName) continue; // pinned per branch

    const isOptional = Array.isArray(field.type) && field.type.includes("null");
    if (!isOptional) sharedRequired.push(field.name);

    const property = convertAvroType(field.type);
    if (field.doc) property.description = field.doc;
    sharedProperties[field.name] = property;
  }

  // ── Step 3: Build one branch per discriminator variant ───────────────────────
  // Each branch = shared fields + pinned discriminator value + branch-specific fields
  const oneOfBranches = branches.map((branch) => {
    const discriminatorValue = branch["x-discriminator-value"]; // e.g. "SAVINGS"

    // Convert the branch-specific fields (e.g. annualInterestRate, minimumBalance)
    const branchProperties = {};
    const branchRequired = [];

    for (const field of branch.fields) {
      const isOptional = Array.isArray(field.type) && field.type.includes("null");
      if (!isOptional) branchRequired.push(field.name);

      const property = convertAvroType(field.type);
      if (field.doc) property.description = field.doc;
      branchProperties[field.name] = property;
    }

    return {
      bsonType: "object",
      // Every branch requires the shared fields + discriminator + the polymorphic field
      required: [...sharedRequired, discriminatorFieldName, polymorphicFieldName],
      properties: {
        ...sharedProperties,

        // Discriminator field pinned to this branch's value.
        // MongoDB uses this to select exactly one oneOf branch.
        [discriminatorFieldName]: {
          bsonType: "string",
          enum: [discriminatorValue],
          description: `Identifies this document as a ${discriminatorValue} account`,
        },

        // Nested object containing the branch-specific required fields
        [polymorphicFieldName]: {
          bsonType: "object",
          required: branchRequired,
          properties: branchProperties,
          additionalProperties: false,
          ...(branch.doc && { title: branch.doc }),
        },
      },
      additionalProperties: false,
    };
  });

  return {
    ...(avroSchema.doc && { title: avroSchema.doc }),
    oneOf: oneOfBranches,
  };
}

// ─── Parse .avsc files that may contain // comments ──────────────────────────
// Standard JSON does not allow comments, but Avro schema files sometimes include
// them for documentation. This strips line comments before parsing.
function parseAvsc(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  const stripped = raw.replace(/\/\/[^\n]*/g, "");
  return JSON.parse(stripped);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.length < 1) {
  console.error(
    "Usage: node avro-to-mongo-validator.js <schema.avsc> [collectionName]"
  );
  process.exit(1);
}

const avroFilePath = args[0];
const collectionName = args[1] || path.basename(avroFilePath, ".avsc");

const avroSchema = parseAvsc(avroFilePath);

// Use polymorphic conversion — falls back to standard if no discriminator found
const mongoSchema = convertPolymorphicRecord(avroSchema);

const command = {
  collMod: collectionName,
  validator: { $jsonSchema: mongoSchema },
  validationLevel: "strict",
  validationAction: "error",
};

const outputDir = path.join(__dirname, "..", "generated");
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

const outputPath = path.join(outputDir, `${collectionName}-validator.json`);
fs.writeFileSync(outputPath, JSON.stringify(command, null, 2));

console.log(`MongoDB validator written to: ${outputPath}`);
