import { diffFields } from './diff';

describe('diffFields', () => {
  const current = { name: 'Alpha', cap: 10, note: 'x' as string | null, days: [0, 6] };

  it('skips undefined, keeps null as a value and compares with ===', () => {
    const { data, changes } = diffFields(
      current,
      { name: 'Alpha', cap: 12, note: null },
      ['name', 'cap', 'note', 'days'] as const,
    );
    expect(data).toEqual({ cap: 12, note: null });
    expect(changes).toEqual({ cap: { from: 10, to: 12 }, note: { from: 'x', to: null } });
  });

  it('compares and records normalised values but writes the value as given', () => {
    const flat = (value: unknown) => (Array.isArray(value) ? value.join(',') : value);
    const same = diffFields(current, { days: [0, 6] }, ['days'] as const, flat);
    expect(same).toEqual({ data: {}, changes: {} });
    const { data, changes } = diffFields(current, { days: [5, 6] }, ['days'] as const, flat);
    expect(data).toEqual({ days: [5, 6] });
    expect(changes).toEqual({ days: { from: '0,6', to: '5,6' } });
  });

  it('only looks at the listed keys', () => {
    expect(diffFields(current, { name: 'Beta', cap: 10 }, ['cap'] as const)).toEqual({
      data: {},
      changes: {},
    });
  });
});
