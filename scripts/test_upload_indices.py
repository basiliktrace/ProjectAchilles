"""--create-index must map the indices the bulk file writes to.

The seed's documents go to achilles-results-synthetic (each action line names
its _index), while --index defaults to achilles-results-. Mapping only --index
left the seeded index dynamically mapped (test_uuid/hostname as text), and the
Executions table's group-key script then failed on that shard.
"""
import json, os, sys, tempfile
sys.path.insert(0, os.path.dirname(__file__))
from upload_to_elasticsearch import indices_in_bulk_file, indices_to_create, populated_indices


def _bulk_file(*indices):
    f = tempfile.NamedTemporaryFile('w', suffix='.ndjson', delete=False)
    for idx in indices:
        action = {"index": {"_index": idx}} if idx else {"index": {}}
        f.write(json.dumps(action) + "\n" + json.dumps({"f0rtika": {"test_uuid": "x"}}) + "\n")
    f.close()
    return f.name


def test_indices_in_bulk_file_are_unique_and_ordered():
    path = _bulk_file("achilles-results-synthetic", "achilles-results-b", "achilles-results-synthetic")
    try:
        assert indices_in_bulk_file(path) == ["achilles-results-synthetic", "achilles-results-b"]
    finally:
        os.unlink(path)


def test_action_without_index_uses_the_upload_default():
    path = _bulk_file(None)
    try:
        assert indices_in_bulk_file(path) == ["achilles-results-"]
    finally:
        os.unlink(path)


def test_indices_to_create_covers_the_file_and_index_flag():
    path = _bulk_file("achilles-results-synthetic")
    try:
        assert indices_to_create("achilles-results-", path) == ["achilles-results-", "achilles-results-synthetic"]
        assert indices_to_create("achilles-results-synthetic", path) == ["achilles-results-synthetic"]
        assert indices_to_create("achilles-results-", None) == ["achilles-results-"]
    finally:
        os.unlink(path)


def test_populated_indices_skips_a_reseed():
    # compose re-runs the one-shot seed on every `up` (each Reconfigure), so a
    # seeded index must not get another batch.
    counts = {"achilles-results-synthetic": 1000, "achilles-results-": 0}
    count = lambda name: counts.get(name)  # None = no such index
    assert populated_indices(count, ["achilles-results-synthetic"]) == ["achilles-results-synthetic"]
    assert populated_indices(count, ["achilles-results-", "achilles-results-other"]) == []


if __name__ == "__main__":
    test_indices_in_bulk_file_are_unique_and_ordered()
    test_action_without_index_uses_the_upload_default()
    test_indices_to_create_covers_the_file_and_index_flag()
    test_populated_indices_skips_a_reseed()
    print("OK: --create-index maps every index the bulk file writes to")
