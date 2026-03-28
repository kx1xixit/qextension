#!/usr/bin/env node

import fs from 'fs';
import fetch from 'node-fetch';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SRC_DIR = path.join(__dirname, '../src');
const BUILD_DIR = path.join(__dirname, '../build');
const OUTPUT_FILE = path.join(BUILD_DIR, 'extension.js');
const OUTPUT_MIN_FILE = path.join(BUILD_DIR, 'min.extension.js');
const OUTPUT_MAX_FILE = path.join(BUILD_DIR, 'pretty.extension.js');

// --- Build State Guard ---
let isBuilding = false;
let pendingBuild = false;

// Create build directory if it doesn't exist
if (!fs.existsSync(BUILD_DIR)) {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
}

/**
 * Read manifest file if it exists
 */
function getManifest() {
  const manifestPath = path.join(SRC_DIR, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (_err) {
      console.warn('Warning: Could not parse manifest.json');
      return {};
    }
  }
  return {};
}

/**
 * Generate Scratch extension header
 */
function generateHeader(manifest) {
  const metadata = {
    name: manifest.name || 'My Extension',
    id: manifest.id || 'myExtension',
    description: manifest.description || 'A TurboWarp extension',
    by: manifest.author || 'Anonymous',
    version: manifest.version || '1.0.0',
    license: manifest.license || 'MIT',
  };

  let header = '';
  header += `// Name: ${metadata.name}\n`;
  header += `// ID: ${metadata.id}\n`;
  header += `// Description: ${metadata.description}\n`;
  header += `// By: ${metadata.by}\n`;
  header += `// License: ${metadata.license}\n`;
  header += `\n`;
  header += `// Version: ${metadata.version}\n`;
  header += `\n`;

  return header;
}

/**
 * Get all JS files from src directory in order
 */
function getSourceFiles() {
  const files = fs
    .readdirSync(SRC_DIR)
    .filter(file => file.endsWith('.js') && !file.startsWith('.'))
    .sort();

  return files.map(file => path.join(SRC_DIR, file));
}

/**
 * Build the extension by concatenating, cleaning, minifying, and maximizing JS files
 */
async function buildExtension() {
  try {
    const manifest = getManifest();
    const header = generateHeader(manifest);
    const sourceFiles = getSourceFiles();

    let output = header;

    // Add IIFE wrapper that takes Scratch as parameter
    output += '(function (Scratch) {\n';
    output += '  "use strict";\n\n';

    // Placeholder for translations - will be injected here after extraction
    const TRANSLATION_MARKER = '  // [[TRANSLATIONS_INJECTION_POINT]]\n\n';
    output += TRANSLATION_MARKER;

    // Concatenate all source files
    sourceFiles.forEach(file => {
      const filename = path.basename(file);
      output += `  // ===== ${filename} =====\n`;

      let content = fs.readFileSync(file, 'utf8');

      /**
       * TRANSFORM MODULES TO PLAIN JS
       */
      // 1. Remove import lines
      content = content.replace(/^import\s+[\s\S]*?from\s+['"].*?['"];?/gm, '');

      // 2. Remove 'export ' prefix
      content = content.replace(/^export\s+/gm, '');

      // Indent the content for the IIFE
      const indentedContent = content
        .split('\n')
        .map(line => {
          return line.length === 0 ? '' : '  ' + line;
        })
        .join('\n');

      output += indentedContent;
      output += '\n\n';
    });

    // --- I18N: extract strings and inject translations ---
    // Parse concatenated output to find Scratch.translate("...") calls
    const translationsCachePath = path.join(__dirname, '..', 'translations-cache.json');
    let cache = {};
    try {
      if (fs.existsSync(translationsCachePath)) {
        const raw = fs.readFileSync(translationsCachePath, 'utf8');
        cache = JSON.parse(raw || '{}');
        console.log('[I18N] Loaded translations cache');
      }
    } catch (err) {
      console.warn('[I18N] Failed to load cache, starting fresh:', err.message);
      cache = {};
    }

    // Helper: collect unique string literals from Scratch.translate calls
    function extractStrings(src) {
      const found = new Set();
      try {
        const ast = parse(src, { sourceType: 'module', plugins: ['jsx'] });
        traverse(ast, {
          CallExpression(path) {
            const callee = path.node.callee;
            // match Scratch.translate(...)
            if (
              callee &&
              callee.type === 'MemberExpression' &&
              callee.object &&
              callee.object.type === 'Identifier' &&
              callee.object.name === 'Scratch' &&
              callee.property &&
              ((callee.property.type === 'Identifier' && callee.property.name === 'translate') ||
                (callee.property.type === 'StringLiteral' && callee.property.value === 'translate'))
            ) {
              const args = path.node.arguments;
              if (args && args.length > 0) {
                if (args[0].type === 'StringLiteral') {
                  found.add(args[0].value);
                } else if (args[0].type === 'ObjectExpression') {
                  // Handle object argument: extract string values from properties
                  const objArg = args[0];
                  if (objArg.properties) {
                    objArg.properties.forEach(prop => {
                      if (prop.value && prop.value.type === 'StringLiteral') {
                        found.add(prop.value.value);
                      }
                    });
                  }
                }
              }
            }
          },
        });
      } catch (err) {
        console.warn('[I18N] AST parse failed:', err.message);
      }
      return Array.from(found);
    }

    const extracted = extractStrings(output);
    console.log(`[I18N] Found ${extracted.length} translatable string(s)`);

    // Target languages to translate into
    let targetLangs = ['es', 'fr', 'de']; // default fallback

    // Try to load from manifest.json first
    try {
      const manifestPath = path.join(SRC_DIR, 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        const manifestData = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (manifestData.locales && Array.isArray(manifestData.locales)) {
          // Validate that all entries are strings
          if (manifestData.locales.every(lang => typeof lang === 'string')) {
            targetLangs = manifestData.locales;
            console.log(`[I18N] Loaded target languages from manifest.json: [${targetLangs.join(', ')}]`);
          } else {
            console.warn('[I18N] manifest.json "locales" contains non-string values, using fallback');
          }
        }
      }
    } catch (err) {
      console.warn(`[I18N] Failed to read locales from manifest.json: ${err.message}, using fallback`);
    }

    // Fall back to environment variable if manifest didn't provide locales
    if (targetLangs.length === 3 && targetLangs[0] === 'es' && targetLangs[1] === 'fr' && targetLangs[2] === 'de') {
      if (process.env.TARGET_LANGS) {
        const envLangs = process.env.TARGET_LANGS.split(',').map(lang => lang.trim()).filter(lang => lang);
        if (envLangs.length > 0) {
          targetLangs = envLangs;
          console.log(`[I18N] Loaded target languages from TARGET_LANGS env: [${targetLangs.join(', ')}]`);
        }
      }
    }

    // Determine which translations are missing in cache
    const toTranslate = {};
    for (const str of extracted) {
      if (!cache[str]) cache[str] = {};
      for (const lang of targetLangs) {
        if (!cache[str][lang]) {
          toTranslate[str] = toTranslate[str] || [];
          toTranslate[str].push(lang);
        }
      }
    }

    // Helper: delay function to avoid rate limiting
    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    const TRANSLATION_DELAY_MS = parseInt(process.env.TRANSLATION_DELAY_MS || '100', 10);

    // Fetch translations for missing entries using LibreTranslate
    async function fetchTranslation(text, target) {
      const url = 'https://libretranslate.de/translate';
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000); // 10 second timeout

      // Escape placeholders: replace [PLACEHOLDER] with __PH0__, __PH1__, etc.
      const placeholderMap = [];
      const placeholderRegex = /\[([^\]]+)\]/g;
      let escapedText = text.replace(placeholderRegex, (match) => {
        const token = `__PH${placeholderMap.length}__`;
        placeholderMap.push(match);
        return token;
      });

      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: escapedText, source: 'en', target, format: 'text' }),
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        let translatedText = json.translatedText || null;

        // Restore original placeholders
        if (translatedText !== null) {
          placeholderMap.forEach((original, index) => {
            const token = `__PH${index}__`;
            translatedText = translatedText.replace(new RegExp(token, 'g'), original);
          });
        }

        return translatedText;
      } catch (err) {
        clearTimeout(timeout);
        console.warn(`[I18N] Failed to translate "${text}" -> ${target}: ${err.message}`);
        return null; // clear failure sentinel
      }
    }

    const translationsByLocale = {};

    // Populate translationsByLocale from cache first
    for (const lang of targetLangs) translationsByLocale[lang] = {};
    for (const [orig, langs] of Object.entries(cache)) {
      for (const [lang, val] of Object.entries(langs)) {
        translationsByLocale[lang] = translationsByLocale[lang] || {};
        translationsByLocale[lang][orig] = val;
      }
    }

    // If there are strings to translate, call API for missing ones
    const missingEntries = Object.keys(toTranslate);
    if (missingEntries.length > 0) {
      console.log(`[I18N] Translating ${missingEntries.length} string(s) (missing in cache)`);
      for (const orig of missingEntries) {
        const langs = toTranslate[orig];
        for (const lang of langs) {
          // eslint-disable-next-line no-await-in-loop
          const translated = await fetchTranslation(orig, lang);
          // Only cache successful translations (skip null sentinel)
          if (translated !== null) {
            cache[orig] = cache[orig] || {};
            cache[orig][lang] = translated;
            translationsByLocale[lang] = translationsByLocale[lang] || {};
            translationsByLocale[lang][orig] = translated;
          }
          // Add delay to avoid rate limiting
          // eslint-disable-next-line no-await-in-loop
          await delay(TRANSLATION_DELAY_MS);
        }
      }

      // Write updated cache
      try {
        fs.writeFileSync(translationsCachePath, JSON.stringify(cache, null, 2), 'utf8');
        console.log('[I18N] Updated translations cache');
      } catch (err) {
        console.warn('[I18N] Failed to write cache:', err.message);
      }
    } else {
      console.log('[I18N] All translations loaded from cache');
    }

    // Inject translations at the prologue marker (before extension code runs)
    // Build locales object: { es: { "Hello": "Hola" }, fr: { ... } }
    const localesObj = JSON.stringify(translationsByLocale, null, 2);
    let translationsCode = `  // Injected translations (available before extension registration)\n`;
    translationsCode += `  // NOTE: This template requires the TurboWarp runtime's Scratch.translate API.\n`;
    translationsCode += `  // Defensive fallback: ensure Scratch.translate exists as a callable function\n`;
    translationsCode += `  if (typeof Scratch.translate !== 'function') {\n`;
    translationsCode += `    Scratch.translate = function(s) { return s; };\n`;
    translationsCode += `  }\n`;
    translationsCode += `  Scratch.translate.locales = ${localesObj};\n`;
    translationsCode += `  if (typeof Scratch.translate.setup !== 'function') {\n`;
    translationsCode += `    Scratch.translate.setup = function(config) {\n`;
    translationsCode += `      if (config && config.locales) {\n`;
    translationsCode += `        Scratch.translate.locales = config.locales;\n`;
    translationsCode += `      }\n`;
    translationsCode += `    };\n`;
    translationsCode += `  }\n`;
    translationsCode += `  Scratch.translate.setup({ locales: Scratch.translate.locales });\n\n`;

    // Replace the marker with the translations code
    output = output.replace(TRANSLATION_MARKER, translationsCode);

    // Close IIFE
    output += '})(Scratch);\n';

    // Optionally strip comments in production mode (preserve the header)
    let finalOutput = output;
    if (productionMode) {
      try {
        const { minify } = await import('terser');
        // Use terser to remove comments while keeping header metadata comments
        const cleaned = await minify(output, {
          compress: false,
          mangle: false,
          format: {
            comments: /^\s*(Name|ID|Description|By|License|Version):/,
            beautify: true,
          },
        });
        if (cleaned && typeof cleaned.code === 'string') {
          finalOutput = cleaned.code;
        }
      } catch (err) {
        if (err && err.code === 'ERR_MODULE_NOT_FOUND') {
          console.warn('        (Skipping comment stripping: "terser" not found)');
        } else {
          console.warn('[PROD] Comment stripping failed:', err);
        }
      }
    }

    // Write standard output
    fs.writeFileSync(OUTPUT_FILE, finalOutput, 'utf8');

    const size = (finalOutput.length / 1024).toFixed(2);
    console.log(`[NORMAL] Standard build successful: ${OUTPUT_FILE} (${size} KB)`);

    // --- Maximization Step (Prettier) ---
    try {
      const { format, resolveConfig } = await import('prettier');
      const prettierConfig = (await resolveConfig(OUTPUT_MAX_FILE)) || {};
      const formatted = await format(finalOutput, {
        ...prettierConfig,
        parser: 'babel',
      });

      fs.writeFileSync(OUTPUT_MAX_FILE, formatted, 'utf8');
      const maxSize = (formatted.length / 1024).toFixed(2);
      console.log(`[PRETTY] Maximized output created: ${OUTPUT_MAX_FILE} (${maxSize} KB)`);
    } catch (err) {
      if (err.code === 'ERR_MODULE_NOT_FOUND') {
        console.warn('        (Skipping maximization: "prettier" not found)');
      } else {
        console.warn('[PRETTY] Maximization failed:', err);
      }
    }

    // --- Minification Step (Terser) ---
    try {
      const { minify } = await import('terser');
      const minified = await minify(finalOutput, {
        compress: true,
        mangle: true,
        format: {
          comments: /^\s*(Name|ID|Description|By|License|Version):/,
        },
      });

      if (minified.code) {
        fs.writeFileSync(OUTPUT_MIN_FILE, minified.code, 'utf8');
        const minSize = (minified.code.length / 1024).toFixed(2);
        console.log(`[MINIFY] Minified output created: ${OUTPUT_MIN_FILE} (${minSize} KB)`);
      }

    } catch (err) {
      if (err.code === 'ERR_MODULE_NOT_FOUND') {
        console.warn('        (Skipping minification: "terser" not found)');
      } else {
        console.warn('[MINIFY] Minification failed:', err);
      }
    }

    return true;
  } catch (err) {
    console.error('✗ Build failed:', err.message);
    return false;
  }
}

/**
 * Coalescing guard to prevent concurrent build runs
 */
async function guardedBuild() {
  if (isBuilding) {
    pendingBuild = true;
    return;
  }

  isBuilding = true;
  await buildExtension();
  isBuilding = false;

  if (pendingBuild) {
    pendingBuild = false;
    // Trigger the next build in the next tick
    setImmediate(guardedBuild);
  }
}

/**
 * Watch for file changes
 */
async function watchFiles() {
  let chokidar;
  try {
    chokidar = (await import('chokidar')).default;
  } catch (_err) {
    console.error('Watch mode requires chokidar. Install it with: npm install --save-dev chokidar');
    process.exit(1);
  }

  console.log('Watching for changes in', SRC_DIR);

  const watcher = chokidar.watch(SRC_DIR, {
    ignored: /(^|[\\/])\./,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 100,
    },
  });

  watcher.on('all', (event, file) => {
    console.log(`[WATCH] ${event}: ${path.basename(file)}`);
    guardedBuild();
  });
}

// Check for --watch flag
const watchMode = process.argv.includes('--watch');
const productionMode = process.argv.includes('--production') || process.env.NODE_ENV === 'production';

// Execute
(async () => {
  // Always run the initial build
  await buildExtension();

  if (watchMode) {
    watchFiles();
  }
})();