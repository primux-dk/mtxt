import { describe, expect, it } from 'vitest';
import { decideDue, findDue, meetingDay, validTimeZone } from '../lib/recap/due';

/** Thursday 22 October 2026, the day of figure 04's meeting. */
const DAY = '2026-10-22';
const due = (text: string) => {
  const found = findDue(text, DAY);
  return found.kind === 'date' ? found.date : found.kind;
};

describe('due dates from Danish phrases, meeting on Thursday 22 October 2026', () => {
  it.each([
    ['Jonas tester det nye skift på torsdag', '2026-10-29'],
    ['Søren melder tilbage i morgen', '2026-10-23'],
    ['Anne opdaterer planen inden fredag klokken tolv', '2026-10-23'],
    ['Kapaciteten øges næste uge', '2026-10-30'],
    ['Tallene samles senest den 30.', '2026-10-30'],
    ['Rapporten skal være klar i dag', '2026-10-22'],
    ['Leverandøren ringes op i overmorgen', '2026-10-24'],
    ['Planen sendes ud den 5. november', '2026-11-05'],
    ['Testen gentages om en uge', '2026-10-29'],
    ['Budgettet afleveres inden udgangen af måneden', '2026-10-31'],
    ['Status mandag i næste uge', '2026-10-26'],
    ['Ordren bekræftes den 3.', '2026-11-03'],
    ['Tilbuddet sendes inden næste uge', '2026-10-23'],
    ['Kontrakten fornyes 1. januar', '2027-01-01'],
  ])('%s → %s', (text, date) => {
    expect(due(text)).toBe(date);
  });

  it.each([
    ['Det nye skift sættes i drift fra mandag', 'none'],
    ['Vi tager den næste fredag', 'unsure'],
    ['Vi nåede de 240 enheder i går', 'none'],
    ['Testen køres på torsdag eller fredag', 'unsure'],
    ['Vi ser på det næste måned', 'unsure'],
    ['Vi følger op snart', 'unsure'],
    ['Det blev aftalt sidste fredag', 'none'],
  ])('%s → %s', (text, kind) => {
    expect(due(text)).toBe(kind);
  });
});

describe('due dates from English phrases, meeting on Thursday 22 October 2026', () => {
  it.each([
    ['Test the new shift on Thursday', '2026-10-29'],
    ['Søren reports back tomorrow', '2026-10-23'],
    ['Anne updates the plan by Friday at noon', '2026-10-23'],
    ['Raise capacity next week', '2026-10-30'],
    ['Collect the figures by the 30th', '2026-10-30'],
    ['Send the summary today', '2026-10-22'],
    ['Call the supplier the day after tomorrow', '2026-10-24'],
    ['Send the plan on 5 November', '2026-11-05'],
    ['Repeat the test in a week', '2026-10-29'],
    ['Hand in the budget by the end of the month', '2026-10-31'],
    ['Status on Monday next week', '2026-10-26'],
    ['Confirm the order on the 3rd', '2026-11-03'],
    ['Renew the contract by November 5th', '2026-11-05'],
    ['Ship it within two weeks', '2026-11-05'],
  ])('%s → %s', (text, date) => {
    expect(due(text)).toBe(date);
  });

  it.each([
    ['The new shift runs from Monday', 'none'],
    ['See you next Friday', 'unsure'],
    ['We finished it yesterday', 'none'],
    ['Run the test Thursday or Friday', 'unsure'],
    ['Look at it next month', 'unsure'],
    ['Follow up soon', 'unsure'],
  ])('%s → %s', (text, kind) => {
    expect(due(text)).toBe(kind);
  });
});

describe('the edges', () => {
  it('reads an ISO date and a day-first date, and calls 3/4 unsure', () => {
    expect(due('Sendes 2026-11-12')).toBe('2026-11-12');
    expect(due('Sendes 30/10')).toBe('2026-10-30');
    expect(due('Sendes 3/4')).toBe('unsure');
  });

  it('never gives a day before the meeting', () => {
    expect(due('Afleveret 2026-10-01')).toBe('none');
    expect(due('Planen sendes 21. oktober 2026')).toBe('none');
  });

  it('moves to the next month that has the day', () => {
    expect(findDue('senest den 31.', '2026-11-05')).toEqual({ kind: 'date', date: '2026-12-31' });
  });

  it('works out the meeting day on the install time zone', () => {
    const late = new Date('2026-10-22T23:30:00Z');
    expect(meetingDay(late, 'UTC')).toBe('2026-10-22');
    expect(meetingDay(late, 'Europe/Copenhagen')).toBe('2026-10-23');
    expect(meetingDay(late, 'Not/AZone')).toBe('2026-10-22');
    // "i morgen" said late on the 22nd UTC is the 24th in Copenhagen.
    expect(findDue('i morgen', meetingDay(late, 'Europe/Copenhagen'))).toEqual({
      kind: 'date',
      date: '2026-10-24',
    });
    expect(validTimeZone('Europe/Copenhagen')).toBe(true);
    expect(validTimeZone('Mars/Olympus')).toBe(false);
  });
});

describe('which due date a drafted decision keeps', () => {
  it('takes the phrase over the model, and none when the phrase is unsure', () => {
    expect(decideDue('Test på torsdag', DAY, '2026-10-23')).toBe('2026-10-29');
    expect(decideDue('Test næste fredag', DAY, '2026-10-23')).toBeNull();
  });

  it("keeps the model's date only when it is a real day within a year from the meeting", () => {
    expect(decideDue('Test det nye skift', DAY, '2026-11-02')).toBe('2026-11-02');
    expect(decideDue('Test det nye skift', DAY, '2026-10-01')).toBeNull();
    expect(decideDue('Test det nye skift', DAY, '2028-01-01')).toBeNull();
    expect(decideDue('Test det nye skift', DAY, '2026-02-31')).toBeNull();
    expect(decideDue('Test det nye skift', DAY, null)).toBeNull();
  });
});
