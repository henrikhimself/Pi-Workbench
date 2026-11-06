import assert from "node:assert/strict";
/** Verified flat legacy and compact-group v0.12.1 JSON contracts. */
export function graphQns(value) {
  if (Array.isArray(value.groups)) {
    const name = value.cols.indexOf("name"); assert.ok(name >= 0);
    return value.groups.flatMap(group => group.rows.map(row => {
      assert.equal(typeof row[name], "string"); assert.equal(typeof group.qn_prefix, "string");
      return group.qn_prefix ? `${group.qn_prefix}.${row[name]}` : row[name];
    }));
  }
  const rows = value.nodes ?? value.results ?? value; assert.ok(Array.isArray(rows));
  return rows.map(row => row.qn ?? row.qualified_name).filter(value => typeof value === "string");
}
