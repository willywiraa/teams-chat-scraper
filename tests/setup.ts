// Provides indexedDB / IDBKeyRange globals (jsdom has no IndexedDB). Tests that need an
// isolated database pass their own `new IDBFactory()` to ArchiveRepository.open().
import 'fake-indexeddb/auto';
