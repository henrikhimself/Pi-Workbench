#!/usr/bin/env python3
"""Canonical Headroom Memory bundle operations. Standard library only.

Called only by extension-owned managed Python after Memory MCP is stopped.  This
script intentionally handles logical SQLite rows, never embeddings or vectors.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import sys
from pathlib import Path
from typing import Any

BUNDLE_VERSION = 1
MEMORY_COLUMNS = (
    "id", "content", "user_id", "session_id", "agent_id", "turn_id",
    "created_at", "valid_from", "valid_until", "category", "importance",
    "supersedes", "superseded_by", "promoted_from", "promotion_chain",
    "entity_refs", "metadata",
)
ENTITY_COLUMNS = (
    "id", "user_id", "name", "entity_type", "description", "properties",
    "created_at", "updated_at", "metadata",
)
RELATIONSHIP_COLUMNS = (
    "id", "user_id", "source_id", "target_id", "relation_type", "weight",
    "properties", "created_at", "metadata",
)


def canonical(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def sql_value(value: Any) -> Any:
    if isinstance(value, (dict, list)):
        return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return value


def logical_row(row: sqlite3.Row, columns: tuple[str, ...]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for column in columns:
        value = row[column]
        if column in {"promotion_chain", "entity_refs", "metadata", "properties"}:
            try:
                value = json.loads(value)
            except (TypeError, json.JSONDecodeError) as error:
                raise ValueError(f"invalid JSON in {column} for {row['id']}") from error
        result[column] = value
    return result


def db_rows(database: Path, query: str, namespace: str, columns: tuple[str, ...]) -> list[dict[str, Any]]:
    if not database.exists():
        return []
    with sqlite3.connect(database) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(query, (namespace,)).fetchall()
    return [logical_row(row, columns) for row in rows]


def write_records(bundle: Path, kind: str, rows: list[dict[str, Any]]) -> list[dict[str, str]]:
    destination = bundle / kind
    destination.mkdir(parents=True, exist_ok=True)
    entries = []
    for row in sorted(rows, key=lambda item: item["id"]):
        name = f"{row['id']}.json"
        payload = canonical(row)
        (destination / name).write_bytes(payload)
        entries.append({"path": f"{kind}/{name}", "sha256": hashlib.sha256(payload).hexdigest()})
    return entries


def export_bundle(store: Path, bundle: Path, namespace: str) -> dict[str, Any]:
    if bundle.exists():
        raise ValueError(f"export directory already exists: {bundle}")
    memories = db_rows(store / "memory.db", "SELECT * FROM memories WHERE user_id = ?", namespace, MEMORY_COLUMNS)
    entities = db_rows(store / "memory_graph.db", "SELECT * FROM entities WHERE user_id = ?", namespace, ENTITY_COLUMNS)
    relationships = db_rows(store / "memory_graph.db", "SELECT * FROM relationships WHERE user_id = ?", namespace, RELATIONSHIP_COLUMNS)
    entries = []
    entries += write_records(bundle, "memories", memories)
    entries += write_records(bundle, "entities", entities)
    entries += write_records(bundle, "relationships", relationships)
    manifest = {"version": BUNDLE_VERSION, "namespace": namespace, "files": sorted(entries, key=lambda item: item["path"])}
    (bundle / "manifest.json").write_bytes(canonical(manifest))
    return {"memories": len(memories), "entities": len(entities), "relationships": len(relationships)}


def validate_bundle_root(bundle: Path) -> Path:
    if bundle.is_symlink() or not bundle.is_dir():
        raise ValueError("bundle directory must be a non-symlink directory")
    return bundle.resolve(strict=True)


def require_bundle_directory(bundle: Path, root: Path, kind: str) -> Path:
    directory = bundle / kind
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError(f"bundle directory must not be a symbolic link: {kind}")
    if not directory.resolve(strict=True).is_relative_to(root):
        raise ValueError(f"bundle directory resolves outside bundle: {kind}")
    return directory


def require_bundle_file(bundle: Path, root: Path, relative_path: str) -> Path:
    components = relative_path.split("/")
    current = bundle
    for component in components:
        current = current / component
        if current.is_symlink():
            raise ValueError(f"bundle path must not be a symbolic link: {relative_path}")
    if not current.is_file():
        raise ValueError(f"bundle file is required: {relative_path}")
    if not current.resolve(strict=True).is_relative_to(root):
        raise ValueError(f"bundle file resolves outside bundle: {relative_path}")
    return current


def read_bundle(bundle: Path, namespace: str) -> dict[str, list[dict[str, Any]]]:
    root = validate_bundle_root(bundle)
    manifest_path = require_bundle_file(bundle, root, "manifest.json")
    manifest = json.loads(manifest_path.read_text("utf-8"))
    if not isinstance(manifest, dict) or manifest.get("version") != BUNDLE_VERSION or manifest.get("namespace") != namespace:
        raise ValueError("bundle manifest version or namespace does not match current Memory configuration")
    files = manifest.get("files")
    if not isinstance(files, list):
        raise ValueError("bundle manifest files must be a list")
    expected = {"manifest.json"}
    result: dict[str, list[dict[str, Any]]] = {"memories": [], "entities": [], "relationships": []}
    for kind in result:
        require_bundle_directory(bundle, root, kind)
    for entry in files:
        if not isinstance(entry, dict) or set(entry) != {"path", "sha256"}:
            raise ValueError("bundle manifest has invalid file entry")
        path, digest = entry["path"], entry["sha256"]
        if not isinstance(path, str) or not isinstance(digest, str) or path.count("/") != 1:
            raise ValueError("bundle manifest has unsafe file path")
        kind, filename = path.split("/", 1)
        if kind not in result or not filename.endswith(".json") or "/" in filename:
            raise ValueError("bundle manifest has unsupported record path")
        expected.add(path)
        record_path = require_bundle_file(bundle, root, path)
        raw = record_path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != digest:
            raise ValueError(f"bundle checksum mismatch: {path}")
        record = json.loads(raw)
        if not isinstance(record, dict) or record.get("user_id") != namespace or record.get("id") != filename[:-5]:
            raise ValueError(f"bundle record identity mismatch: {path}")
        if canonical(record) != raw:
            raise ValueError(f"bundle record is not canonical JSON: {path}")
        result[kind].append(record)
    # Configured export directories may contain unrelated project files. Only
    # pi-workbench-owned bundle names participate in bundle validation.
    actual = {
        relative_path
        for p in bundle.rglob("*") if p.is_file()
        for relative_path in (p.relative_to(bundle).as_posix(),)
        if relative_path == "manifest.json" or relative_path.split("/", 1)[0] in result
    }
    if actual != expected:
        raise ValueError("bundle contains unlisted or missing owned files")
    validate_references(result)
    return result


def validate_references(records: dict[str, list[dict[str, Any]]]) -> None:
    memory_ids = {record["id"] for record in records["memories"]}
    entity_ids = {record["id"] for record in records["entities"]}
    if len(memory_ids) != len(records["memories"]) or len(entity_ids) != len(records["entities"]):
        raise ValueError("bundle contains duplicate record IDs")
    for record in records["memories"]:
        for field in ("supersedes", "superseded_by", "promoted_from"):
            if record.get(field) is not None and record[field] not in memory_ids:
                raise ValueError(f"memory {record['id']} references missing {field}")
        if any(entity_id not in entity_ids for entity_id in record.get("entity_refs", [])):
            raise ValueError(f"memory {record['id']} references missing entity")
    for record in records["relationships"]:
        if record.get("source_id") not in entity_ids or record.get("target_id") not in entity_ids:
            raise ValueError(f"relationship {record['id']} references missing entity")


def insert_rows(conn: sqlite3.Connection, table: str, columns: tuple[str, ...], rows: list[dict[str, Any]]) -> None:
    if not rows:
        return
    insert_columns = columns
    prepared = [{key: sql_value(value) for key, value in row.items()} for row in rows]
    # SQLiteGraphStore keeps this lookup column derived from canonical name.
    if table == "entities":
        insert_columns = ("id", "user_id", "name", "name_lower", "entity_type", "description", "properties", "created_at", "updated_at", "metadata")
        for row in prepared:
            row["name_lower"] = str(row["name"]).lower()
    names = ", ".join(insert_columns)
    values = ", ".join(f":{column}" for column in insert_columns)
    conn.executemany(f"INSERT OR REPLACE INTO {table} ({names}) VALUES ({values})", prepared)


def show_memories(store: Path, namespace: str) -> dict[str, list[dict[str, Any]]]:
    memories = db_rows(
        store / "memory.db",
        "SELECT * FROM memories WHERE user_id = ? AND valid_until IS NULL ORDER BY created_at, id",
        namespace,
        MEMORY_COLUMNS,
    )
    return {"memories": memories}


def merge_rows(conn: sqlite3.Connection, table: str, columns: tuple[str, ...], rows: list[dict[str, Any]]) -> dict[str, int]:
    existing = {
        row["id"]: logical_row(row, columns)
        for row in conn.execute(f"SELECT * FROM {table} WHERE user_id = ?", (rows[0]["user_id"],)).fetchall()
    } if rows else {}
    added = updated = unchanged = 0
    for row in rows:
        previous = existing.get(row["id"])
        if previous is None:
            added += 1
        elif canonical(previous) == canonical(row):
            unchanged += 1
            continue
        else:
            updated += 1
        insert_rows(conn, table, columns, [row])
    return {"added": added, "updated": updated, "unchanged": unchanged}


def merge_namespace(stage: Path, records: dict[str, list[dict[str, Any]]], namespace: str) -> dict[str, dict[str, int]]:
    memory_db, graph_db = stage / "memory.db", stage / "memory_graph.db"
    with sqlite3.connect(memory_db) as conn:
        conn.row_factory = sqlite3.Row
        # Preserve local retrieval telemetry when incoming logical record wins.
        access = {row["id"]: (row["access_count"], row["last_accessed"]) for row in conn.execute("SELECT id, access_count, last_accessed FROM memories WHERE user_id = ?", (namespace,))}
        stats = merge_rows(conn, "memories", MEMORY_COLUMNS, records["memories"])
        for memory_id, (access_count, last_accessed) in access.items():
            conn.execute("UPDATE memories SET access_count = ?, last_accessed = ? WHERE id = ?", (access_count, last_accessed, memory_id))
    with sqlite3.connect(graph_db) as conn:
        conn.row_factory = sqlite3.Row
        entity_stats = merge_rows(conn, "entities", ENTITY_COLUMNS, records["entities"])
        relationship_stats = merge_rows(conn, "relationships", RELATIONSHIP_COLUMNS, records["relationships"])
    return {"memories": stats, "entities": entity_stats, "relationships": relationship_stats}


def replace_namespace(stage: Path, records: dict[str, list[dict[str, Any]]], namespace: str) -> None:
    memory_db, graph_db = stage / "memory.db", stage / "memory_graph.db"
    with sqlite3.connect(memory_db) as conn:
        conn.execute("DELETE FROM memories WHERE user_id = ?", (namespace,))
        insert_rows(conn, "memories", MEMORY_COLUMNS, records["memories"])
    with sqlite3.connect(graph_db) as conn:
        conn.execute("DELETE FROM relationships WHERE user_id = ?", (namespace,))
        conn.execute("DELETE FROM entities WHERE user_id = ?", (namespace,))
        insert_rows(conn, "entities", ENTITY_COLUMNS, records["entities"])
        insert_rows(conn, "relationships", RELATIONSHIP_COLUMNS, records["relationships"])
    # Vector and FTS state is derived. Rebuild it with managed CPU ONNX below.
    for derived in ("memory_vectors.db", "memory.db-wal", "memory.db-shm", "memory_graph.db-wal", "memory_graph.db-shm"):
        path = stage / derived
        if path.exists(): path.unlink()


def rebuild_indexes(store: Path) -> None:
    import asyncio
    from headroom.memory.backends.local import LocalBackend, LocalBackendConfig

    async def rebuild() -> None:
        backend = LocalBackend(LocalBackendConfig(db_path=str(store / "memory.db"), embedder_backend="onnx"))
        with sqlite3.connect(store / "memory.db") as conn:
            ids = [row[0] for row in conn.execute("SELECT id FROM memories")]
        for memory_id in ids:
            await backend.refresh_memory_indexes(memory_id)

    asyncio.run(rebuild())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("export", "validate", "replace", "merge", "show"))
    parser.add_argument("--store", required=True, type=Path)
    parser.add_argument("--bundle", required=True, type=Path)
    parser.add_argument("--namespace", required=True)
    args = parser.parse_args()
    if args.operation == "export":
        result = export_bundle(args.store, args.bundle, args.namespace)
    elif args.operation == "show":
        result = show_memories(args.store, args.namespace)
    else:
        records = read_bundle(args.bundle, args.namespace)
        if args.operation == "replace":
            replace_namespace(args.store, records, args.namespace)
            rebuild_indexes(args.store)
            result = {kind: len(rows) for kind, rows in records.items()}
        elif args.operation == "merge":
            result = merge_namespace(args.store, records, args.namespace)
            rebuild_indexes(args.store)
        else:
            result = {kind: len(rows) for kind, rows in records.items()}
    print(json.dumps(result, sort_keys=True))

if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Headroom Memory bundle error: {error}", file=sys.stderr)
        sys.exit(1)
