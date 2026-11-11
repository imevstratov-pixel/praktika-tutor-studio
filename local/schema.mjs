const string = () => ({type:'string'});
const array = (items, minItems) => ({type:'array', items, ...(minItems ? {minItems} : {})});
const object = properties => ({type:'object', properties, required:Object.keys(properties), additionalProperties:false});
const topicId = () => ({type:'string', pattern:'^t[1-9][0-9]?$'});
const termId = () => ({type:'string', pattern:'^k[1-9][0-9]?$'});
const nodeId = () => ({type:'string', pattern:'^[tk][1-9][0-9]?$'});

/** A fresh schema per request, with source IDs restricted to its real excerpts.
 * Keep the generation grammar small: combinatorial length/count constraints can
 * exceed a provider's grammar budget. All size limits, cross-record references,
 * unique names and literal quotations remain enforced by validateGraph. */
export function graphJsonSchema(excerpts) {
  if (!Array.isArray(excerpts) || !excerpts.length || excerpts.some(item => !item || typeof item.id !== 'string' || !/^e[1-9][0-9]*$/u.test(item.id))) {
    throw new TypeError('Нужны пронумерованные исходные фрагменты.');
  }
  const evidenceIds = [...new Set(excerpts.map(item => item.id))];
  const evidence = () => array(object({
    id:{type:'string', enum:[...evidenceIds]},
    quote:string(),
  }), 1);
  return object({
    title:string(),
    // Empty collections remain possible for a source without educational
    // content; validateGraph reports that as 422 instead of inventing a topic.
    topics:array(object({
      id:topicId(), name:string(), summary:string(), evidence:evidence(),
    })),
    terms:array(object({
      id:termId(), name:string(), definition:string(),
      topicIds:array(topicId(), 1), evidence:evidence(),
    })),
    links:array(object({
      from:nodeId(), to:nodeId(), relation:string(), evidence:evidence(),
    })),
  });
}
