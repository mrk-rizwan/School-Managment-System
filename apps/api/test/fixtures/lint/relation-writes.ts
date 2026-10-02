export const writes = [
  { data: { school: { connect: { id: 1n } } } },
  { data: { school: { connectOrCreate: {} } } },
  { data: { sections: { set: [] } } },
  { data: { guardian: { disconnect: true } } },
];
