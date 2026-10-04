// expo-secure-store in memory, for Jest. Tests read `secureStoreContents()` to assert exactly
// which keys a flow leaves behind.

const store = new Map<string, string>();

export const getItemAsync = (key: string) => Promise.resolve(store.get(key) ?? null);

export function setItemAsync(key: string, value: string): Promise<void> {
  store.set(key, value);
  return Promise.resolve();
}

export function deleteItemAsync(key: string): Promise<void> {
  store.delete(key);
  return Promise.resolve();
}

export const secureStoreContents = (): Record<string, string> => Object.fromEntries(store);

export function resetSecureStore(): void {
  store.clear();
}
