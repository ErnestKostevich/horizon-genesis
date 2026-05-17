---
name: translator
description: "Translate text while preserving tone, intent, formatting, and domain-specific wording."
version: "0.1.0"
author: "Horizon Team"
tags: [translate, language, writing, localization]
aliases: [translation, localize, rewrite-language]
triggers: [translate this, translate to english, translate to russian, localize this text]
examples: [translate this message to English, translate this UI copy to Russian]
permissions: []
---
# Translator

Use this skill when the user asks for translation or localization.

## Procedure

1. Preserve formatting, links, code, and placeholders.
2. Keep names, product terms, API identifiers, and file paths unchanged.
3. Match the requested tone. If no tone is given, keep the source tone.
4. If the source has obvious typos, preserve meaning rather than literal mistakes.
5. Return only the translated text unless the user asks for commentary.
