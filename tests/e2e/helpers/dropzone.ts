/**
 * Upload files through one of the app's click-to-pick dropzones.
 *
 * `src/components/sites/Dropzone.tsx` keeps NO <input type="file"> in the DOM.
 * On click it creates a detached input and calls .click() on it (see
 * openPicker). So `page.locator('input[type="file"]')` never resolves on the
 * Sites pages, and the three reality-check specs that used it waited on it
 * until the test timeout (setInputFiles / evaluate "waiting for locator").
 * The feature was there the whole time; the specs were looking for an element
 * that has never existed.
 *
 * Playwright's file-chooser event fires for detached inputs too, so this goes
 * through the same click a person makes and needs nothing from the product.
 */
import { expect, type FileChooser, type Page } from "@playwright/test";

type Files = Parameters<FileChooser["setFiles"]>[0];

export interface DropzonePick {
  /** Whether the picker the dropzone opened accepts more than one file. */
  multiple: boolean;
}

/**
 * Click the dropzone, catch the native file chooser it opens, and hand it
 * `files`. When several files are passed but the chooser is single-file, no
 * file is set and `multiple: false` comes back, so the caller can skip with
 * that reason instead of Playwright throwing.
 */
export async function pickFilesThroughDropzone(
  page: Page,
  dropzoneTestId: string,
  files: Files,
): Promise<DropzonePick> {
  const zone = page.getByTestId(dropzoneTestId).first();
  await expect(
    zone,
    `dropzone [data-testid=${dropzoneTestId}] must render (is the page signed in?)`,
  ).toBeVisible({ timeout: 20_000 });
  const chooserPromise = page.waitForEvent("filechooser", { timeout: 10_000 });
  await zone.click();
  const chooser = await chooserPromise;
  const multiple = chooser.isMultiple();
  const many = Array.isArray(files) && files.length > 1;
  await chooser.setFiles(many && !multiple ? [] : files);
  return { multiple };
}
