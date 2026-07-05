const stores = new Map();

const getStore = id => {
  const key = id ?? 'default';
  let store = stores.get(key);
  if (!store) {
    store = new Map();
    stores.set(key, store);
  }
  return store;
};

exports.createMMKV = options => {
  const store = getStore(options && options.id);
  return {
    getString: key => store.get(key),
    set: (key, value) => {
      store.set(key, String(value));
    },
    remove: key => {
      store.delete(key);
    },
    getAllKeys: () => Array.from(store.keys()),
    clearAll: () => {
      store.clear();
    }
  };
};
