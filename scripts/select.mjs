// The app's selects (src/web/chip-select.tsx) open a managed list instead of
// the native picker, so checks choose an option the way a person does: open
// the chip, then click the option. The list follows the chip, in a frame too,
// and must be closed afterwards, even when a label wraps the chip.
import { expect } from '../engine/node_modules/@playwright/test/index.mjs';
export const selectOptions = select => select.locator('xpath=following-sibling::*[@role="listbox"][1]').locator('[role="option"]');
export async function selectOption(select, value) {
  // The chip itself, since a choice such as a language can rename it.
  const chip = await select.elementHandle();
  await select.click();
  await selectOptions(select).and(select.page().locator(`[data-value=${JSON.stringify(value)}]`)).click();
  await expect.poll(() => chip.getAttribute('aria-expanded')).toBe('false');
  await chip.dispose();
}
export const selectedValue = select => select.getAttribute('data-value');
