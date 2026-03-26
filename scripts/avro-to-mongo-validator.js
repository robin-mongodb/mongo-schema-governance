const fs = require("fs");
const path = require("path");

// Avro primitive type → MongoDB bsonType
function avroPrimitiveToBsonType(avroType) {
  const mapping = {
    string: "string",
    int: "int",
    long: "long",
    float: "double", // MongoDB has no "float" — uses double
    double: "double",
    boolean: "bool", // Avro says "boolean", MongoDB says "bool"
    bytes: "binData",
    null: "null",
  };
  return mapping[avroType] || "string";
}

// Convert a single Avro field type to a MongoDB property schema
function convertAvroType(avroType) {
  // Simple primitive: "string", "int", etc.
  if (typeof avroType === "string") {
    return { bsonType: avroPrimitiveToBsonType(avroType) };
  }

  // Union type: ["null", "string"] means optional field
  if (Array.isArray(avroType)) {
    const nonNullTypes = avroType.filter((t) => t !== "null");
    if (nonNullTypes.length === 1) {
      return convertAvroType(nonNullTypes[0]);
    }
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

// Convert an Avro record to a MongoDB $jsonSchema object
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

// Main
const args = process.argv.slice(2);
if (args.length < 1) {
  console.error(
    "Usage: node avro-to-mongo-validator.js <schema.avsc> [collectionName]",
  );
  process.exit(1);
}

const avroFilePath = args[0];
const collectionName = args[1] || path.basename(avroFilePath, ".avsc");

const avroSchema = JSON.parse(fs.readFileSync(avroFilePath, "utf-8"));
const mongoSchema = convertRecord(avroSchema);

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
