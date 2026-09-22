import {z, type ZodTypeAny} from 'zod';
import {zodToJsonSchema} from 'zod-to-json-schema';
import type {TSchema} from 'typebox';

/** Publish the same input shape that execution validates. Refinements still run on submission. */
export function resultToolParameters(schema:ZodTypeAny):TSchema {
 const {$schema,...parameters}=zodToJsonSchema(z.object({result:schema}),{$refStrategy:'none',effectStrategy:'input',removeAdditionalStrategy:'strict'});
 return parameters as TSchema;
}
