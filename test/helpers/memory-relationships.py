"""Synthetic native-graph seed/assert helper; standard library only."""
import json
import sqlite3
import sys

mode, database = sys.argv[1:]
with sqlite3.connect(database) as conn:
    if mode == "seed":
        for identifier, name in [("fixture-a", "Fixture A"), ("fixture-b", "Fixture B")]:
            conn.execute(
                "INSERT INTO entities(id,user_id,name,name_lower,entity_type,properties,created_at,updated_at,metadata) VALUES (?,?,?,?,?,?,?,?,?)",
                (identifier, "fixture", name, name.lower(), "service", "{}", "2020-01-01", "2020-01-01", "{}"),
            )
        conn.execute(
            "INSERT INTO relationships(id,user_id,source_id,target_id,relation_type,weight,properties,created_at,metadata) VALUES (?,?,?,?,?,?,?,?,?)",
            ("fixture-rel", "fixture", "fixture-a", "fixture-b", "depends_on", 1.0, "{}", "2020-01-01", "{}"),
        )
    elif mode == "assert":
        entities = conn.execute("SELECT count(*) FROM entities WHERE id IN ('fixture-a','fixture-b')").fetchone()[0]
        relationships = conn.execute("SELECT count(*) FROM relationships WHERE id='fixture-rel'").fetchone()[0]
        assert entities == 2 and relationships == 1
        print(json.dumps({"entities": entities, "relationships": relationships}))
    else:
        raise ValueError("Unknown fixture mode")
