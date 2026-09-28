import fs from 'fs';
import path from 'path';

// List of exceptions (files explicitly allowed to set auth/session cookies directly)
const EXCEPTIONS = [
  'src/lib/crypto/cookies.ts', // This file contains the setAuthCookie implementation
];

// Auth/session cookie names to check for
const COOKIE_NAMES = ['auth', 'session'];

// Recursively collect all .ts and .tsx files under the src directory
function getAllSourceFiles(dir: string): string[] {
  let results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(getAllSourceFiles(fullPath));
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      results.push(fullPath);
    }
  }

  return results;
}

// Check if a file contains a direct .set() call for auth/session cookies
function fileContainsDirectCookieSet(filePath: string): boolean {
  const content = fs.readFileSync(filePath, 'utf8');

  for (const cookieName of COOKIE_NAMES) {
    const directSetPattern = new RegExp(`\\.set\\(['"\`]${cookieName}['"\`]`, 'i');
    if (directSetPattern.test(content)) {
      return true;
    }
  }

  return false;
}

// Test suite
describe('no-direct-auth-cookie', () => {
  it('should ensure auth/session cookies are only written via setAuthCookie', () => {
    const srcDir = path.join(__dirname, '../');
    const sourceFiles = getAllSourceFiles(srcDir);

    const violations: string[] = [];

    for (const file of sourceFiles) {
      const relativePath = path.relative(srcDir, file);

      // Skip files in the exceptions list
      if (EXCEPTIONS.includes(relativePath)) {
        continue;
      }

      if (fileContainsDirectCookieSet(file)) {
        violations.push(relativePath);
      }
    }

    if (violations.length > 0) {
      const violationList = violations.join('\n');
      throw new Error(
        `Direct auth/session cookie .set() calls are not allowed outside of setAuthCookie.\n` +
        `Found violations in the following files:\n${violationList}`
      );
    }
  });
});