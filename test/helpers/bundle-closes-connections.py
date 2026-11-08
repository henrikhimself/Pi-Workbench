"""L14: every SQLite connection memory-bundle.py opens is closed, and replace_namespace closes them before it unlinks derived files."""
import importlib.util, json, sqlite3, sys, tempfile
from pathlib import Path

spec = importlib.util.spec_from_file_location("memory_bundle", sys.argv[1])
bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle)

real_connect = sqlite3.connect
opened = []

class Spy:
    """Delegates to a real connection and records close(); sqlite3.Connection.close can't be patched in place."""
    def __init__(self, connection):
        object.__setattr__(self, "_connection", connection)
        object.__setattr__(self, "closed", False)
        opened.append(self)
    def __getattr__(self, name): return getattr(self._connection, name)
    def __setattr__(self, name, value): setattr(self._connection, name, value)
    def __enter__(self): self._connection.__enter__(); return self
    def __exit__(self, *args): return self._connection.__exit__(*args)
    def close(self):
        self._connection.close(); object.__setattr__(self, "closed", True)

sqlite3.connect = lambda *args, **kwargs: Spy(real_connect(*args, **kwargs))

with tempfile.TemporaryDirectory() as directory:
    stage = Path(directory)
    memory_columns, entity_columns, relationship_columns = bundle.MEMORY_COLUMNS, bundle.ENTITY_COLUMNS, bundle.RELATIONSHIP_COLUMNS
    for name, table, columns in (("memory.db", "memories", memory_columns), ("memory_graph.db", "entities", entity_columns)):
        connection = real_connect(stage / name)
        extra = ["access_count", "last_accessed"] if table == "memories" else []
        connection.execute(f"CREATE TABLE {table} ({', '.join(list(columns) + [c for c in extra if c not in columns])})")
        if name == "memory_graph.db":
            connection.execute(f"CREATE TABLE relationships ({', '.join(relationship_columns)})")
        connection.commit(); connection.close()
    (stage / "memory_vectors.db").write_text("derived")
    unlinked_with_open = []
    real_unlink = Path.unlink
    def unlink(self, *args, **kwargs):
        unlinked_with_open.append([c.closed for c in opened])
        return real_unlink(self, *args, **kwargs)
    Path.unlink = unlink
    records = {"memories": [], "entities": [], "relationships": []}
    bundle.replace_namespace(stage, records, "tester")
    bundle.merge_namespace(stage, records, "tester")
    bundle.db_rows(stage / "memory.db", "SELECT * FROM memories WHERE user_id = ?", "tester", tuple(memory_columns))

print(json.dumps({
    "opened": len(opened),
    "allClosed": all(c.closed for c in opened),
    "closedBeforeUnlink": all(all(state) for state in unlinked_with_open) and bool(unlinked_with_open),
}))
