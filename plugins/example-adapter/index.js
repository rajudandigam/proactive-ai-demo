module.exports = {
  id: 'playground-example-adapter',
  async register() {
    return { ok: true, note: 'placeholder — install @agent-inspect/adapter-sdk for conformance' };
  },
};
