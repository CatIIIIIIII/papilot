// The app's selects (src/web/chip-select.tsx) open a managed list instead of
// the native picker, so checks choose an option the way a person does: open
// the chip, then click the option. The list follows the chip, in a frame too.
export const selectOptions = select => select.locator('xpath=following-sibling::*[@role="listbox"][1]').locator('[role="option"]');
export async function selectOption(select, value) {
  await select.click();
  await selectOptions(select).and(select.page().locator(`[data-value=${JSON.stringify(value)}]`)).click();
}
export const selectedValue = select => select.getAttribute('data-value');
