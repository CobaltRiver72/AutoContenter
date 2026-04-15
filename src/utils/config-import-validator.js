'use strict';

/**
 * Validate a parsed config-import JSON object against the v1.0 schema.
 *
 * Pure validation: no DB access, no network calls, no WordPress lookups,
 * no file I/O. The downstream import engine performs DB cross-reference
 * checks separately. Synchronous and pure — same input, same output.
 *
 * @param {object} parsedConfig — already JSON.parse'd, never null
 * @returns {{ ok: boolean, errors: Array<{path, message}>, warnings: Array<{path, message}> }}
 *
 * Any entry in `errors` blocks the import (ok=false). Non-blocking issues
 * go to `warnings` instead. Earlier drafts had a 'soft' severity tier for
 * future tightening, but no caller differentiated — removed for clarity.
 */

var SLUG_RE = /^[a-z0-9-]+$/;
var USERNAME_RE = /^[a-z0-9_-]+$/;
var RULE_KEY_RE = /^[a-z0-9_]+$/;
var POST_STATUSES = ['draft', 'publish', 'pending', 'private'];
var COMMENT_PING_STATUSES = ['', 'open', 'closed'];
var KNOWN_TOP_LEVEL_KEYS = [
  'version',
  'generated_at',
  'notes',
  'defaults',
  'authors',
  'categories',
  'tags',
  'routing_hints',
  'publish_rules',
  'modules',
];
var KNOWN_MODULE_KEYS = [
  'news_pipeline',
  'fuel_posts',
  'metals_posts',
  'lottery_posts',
];
var MAX_TAG_CANONICAL_LENGTH = 200;

function _isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    Object.prototype.toString.call(value) === '[object Object]'
  );
}

function _isString(value) {
  return typeof value === 'string';
}

function _isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function _isBoolean(value) {
  return typeof value === 'boolean';
}

function _isArray(value) {
  return Object.prototype.toString.call(value) === '[object Array]';
}

function _isInteger(value) {
  return typeof value === 'number' && isFinite(value) && Math.floor(value) === value;
}

function _indexOf(arr, value) {
  for (var i = 0; i < arr.length; i++) {
    if (arr[i] === value) {
      return i;
    }
  }
  return -1;
}

function _hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function _pushError(errors, path, message) {
  errors.push({
    path: path,
    message: message,
  });
}

function _pushWarning(warnings, path, message) {
  warnings.push({
    path: path,
    message: message,
  });
}

function _describeType(value) {
  if (value === null) {
    return 'null';
  }
  if (_isArray(value)) {
    return 'array';
  }
  return typeof value;
}

function _validateKeywordsMap(keywords, path, errors, warnings) {
  if (keywords === undefined) {
    return;
  }
  if (!_isPlainObject(keywords)) {
    _pushError(
      errors,
      path,
      'keywords must be an object mapping keyword (string) to integer score or null, got ' +
        _describeType(keywords)
    );
    return;
  }
  var keys = [];
  for (var k in keywords) {
    if (_hasOwn(keywords, k)) {
      keys.push(k);
    }
  }
  if (keys.length === 0) {
    _pushWarning(
      warnings,
      path,
      'keywords object is empty — admin may have forgotten to populate it'
    );
    return;
  }
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var val = keywords[key];
    var entryPath = path + '["' + key + '"]';
    if (val === null) {
      // null is allowed (means delete)
      continue;
    }
    if (!_isInteger(val)) {
      _pushError(
        errors,
        entryPath,
        'keyword score must be an integer between 0 and 20 (or null to delete), got ' +
          _describeType(val)
      );
      continue;
    }
    if (val < 0 || val > 20) {
      _pushError(
        errors,
        entryPath,
        'keyword score must be between 0 and 20 inclusive, got ' + val
      );
      continue;
    }
    if (val > 15) {
      _pushWarning(
        warnings,
        entryPath,
        'keyword score ' + val + ' is unusually high (>15); confirm this is intentional'
      );
    }
  }
}

function _validateDefaults(defaults, errors, warnings) {
  if (defaults === undefined) {
    return;
  }
  var path = 'defaults';
  if (!_isPlainObject(defaults)) {
    _pushError(
      errors,
      path,
      'defaults must be an object, got ' + _describeType(defaults)
    );
    return;
  }
  if (defaults.post_status !== undefined) {
    if (!_isString(defaults.post_status)) {
      _pushError(
        errors,
        path + '.post_status',
        'post_status must be a string, got ' + _describeType(defaults.post_status)
      );
    } else if (_indexOf(POST_STATUSES, defaults.post_status) === -1) {
      _pushError(
        errors,
        path + '.post_status',
        'post_status must be one of: ' +
          POST_STATUSES.join(', ') +
          '; got "' +
          defaults.post_status +
          '"'
      );
    }
  }
  if (defaults.comment_status !== undefined) {
    if (!_isString(defaults.comment_status)) {
      _pushError(
        errors,
        path + '.comment_status',
        'comment_status must be a string, got ' + _describeType(defaults.comment_status)
      );
    } else if (_indexOf(COMMENT_PING_STATUSES, defaults.comment_status) === -1) {
      _pushError(
        errors,
        path + '.comment_status',
        'comment_status must be one of: "", "open", "closed"; got "' +
          defaults.comment_status +
          '"'
      );
    }
  }
  if (defaults.ping_status !== undefined) {
    if (!_isString(defaults.ping_status)) {
      _pushError(
        errors,
        path + '.ping_status',
        'ping_status must be a string, got ' + _describeType(defaults.ping_status)
      );
    } else if (_indexOf(COMMENT_PING_STATUSES, defaults.ping_status) === -1) {
      _pushError(
        errors,
        path + '.ping_status',
        'ping_status must be one of: "", "open", "closed"; got "' +
          defaults.ping_status +
          '"'
      );
    }
  }
  if (defaults.default_author_username !== undefined) {
    if (!_isString(defaults.default_author_username)) {
      _pushError(
        errors,
        path + '.default_author_username',
        'default_author_username must be a string, got ' +
          _describeType(defaults.default_author_username)
      );
    } else if (!USERNAME_RE.test(defaults.default_author_username)) {
      _pushError(
        errors,
        path + '.default_author_username',
        'default_author_username must match /^[a-z0-9_-]+$/; got "' +
          defaults.default_author_username +
          '"'
      );
    }
  }
  if (defaults.default_category_slug !== undefined) {
    if (!_isString(defaults.default_category_slug)) {
      _pushError(
        errors,
        path + '.default_category_slug',
        'default_category_slug must be a string, got ' +
          _describeType(defaults.default_category_slug)
      );
    } else if (!SLUG_RE.test(defaults.default_category_slug)) {
      _pushError(
        errors,
        path + '.default_category_slug',
        'default_category_slug must match /^[a-z0-9-]+$/; got "' +
          defaults.default_category_slug +
          '"'
      );
    }
  }
}

function _validateAuthor(author, index, errors, warnings, seenUsernames) {
  var path = 'authors[' + index + ']';
  if (!_isPlainObject(author)) {
    _pushError(
      errors,
      path,
      'author entry must be an object, got ' + _describeType(author)
    );
    return;
  }
  if (!_hasOwn(author, 'username')) {
    _pushError(errors, path + '.username', 'username is required');
  } else if (!_isString(author.username)) {
    _pushError(
      errors,
      path + '.username',
      'username must be a string, got ' + _describeType(author.username)
    );
  } else if (!USERNAME_RE.test(author.username)) {
    _pushError(
      errors,
      path + '.username',
      'username must match /^[a-z0-9_-]+$/; got "' + author.username + '"'
    );
  } else {
    if (_hasOwn(seenUsernames, author.username)) {
      _pushError(
        errors,
        path + '.username',
        'duplicate author username "' +
          author.username +
          '" (first seen at authors[' +
          seenUsernames[author.username] +
          '])'
      );
    } else {
      seenUsernames[author.username] = index;
    }
  }
  if (author.display_name !== undefined && !_isString(author.display_name)) {
    _pushError(
      errors,
      path + '.display_name',
      'display_name must be a string, got ' + _describeType(author.display_name)
    );
  }
  if (author.beats !== undefined) {
    if (!_isArray(author.beats)) {
      _pushError(
        errors,
        path + '.beats',
        'beats must be an array of strings, got ' + _describeType(author.beats)
      );
    } else {
      for (var b = 0; b < author.beats.length; b++) {
        if (!_isString(author.beats[b])) {
          _pushError(
            errors,
            path + '.beats[' + b + ']',
            'beat must be a string, got ' + _describeType(author.beats[b])
          );
        }
      }
    }
  }
  _validateKeywordsMap(author.keywords, path + '.keywords', errors, warnings);
}

function _validateCategory(category, index, errors, warnings, seenSlugs) {
  var path = 'categories[' + index + ']';
  if (!_isPlainObject(category)) {
    _pushError(
      errors,
      path,
      'category entry must be an object, got ' + _describeType(category)
    );
    return;
  }
  if (!_hasOwn(category, 'slug')) {
    _pushError(errors, path + '.slug', 'slug is required');
  } else if (!_isString(category.slug)) {
    _pushError(
      errors,
      path + '.slug',
      'slug must be a string, got ' + _describeType(category.slug)
    );
  } else if (!SLUG_RE.test(category.slug)) {
    _pushError(
      errors,
      path + '.slug',
      'slug must match /^[a-z0-9-]+$/; got "' + category.slug + '"'
    );
  } else {
    if (_hasOwn(seenSlugs, category.slug)) {
      _pushError(
        errors,
        path + '.slug',
        'duplicate category slug "' +
          category.slug +
          '" (first seen at categories[' +
          seenSlugs[category.slug] +
          '])'
      );
    } else {
      seenSlugs[category.slug] = index;
    }
  }
  if (category.display_name !== undefined && !_isString(category.display_name)) {
    _pushError(
      errors,
      path + '.display_name',
      'display_name must be a string, got ' + _describeType(category.display_name)
    );
  }
  if (category.default_author_username !== undefined) {
    if (!_isString(category.default_author_username)) {
      _pushError(
        errors,
        path + '.default_author_username',
        'default_author_username must be a string, got ' +
          _describeType(category.default_author_username)
      );
    } else if (!USERNAME_RE.test(category.default_author_username)) {
      _pushError(
        errors,
        path + '.default_author_username',
        'default_author_username must match /^[a-z0-9_-]+$/; got "' +
          category.default_author_username +
          '"'
      );
    }
  }
  _validateKeywordsMap(category.keywords, path + '.keywords', errors, warnings);
}

function _validateTags(tags, errors, warnings) {
  if (tags === undefined) {
    return;
  }
  var path = 'tags';
  if (!_isPlainObject(tags)) {
    _pushError(
      errors,
      path,
      'tags must be an object mapping raw term to canonical name, got ' +
        _describeType(tags)
    );
    return;
  }
  var canonicalToRaw = {};
  for (var raw in tags) {
    if (!_hasOwn(tags, raw)) {
      continue;
    }
    var entryPath = path + '["' + raw + '"]';
    var canonical = tags[raw];
    if (!_isString(canonical)) {
      _pushError(
        errors,
        entryPath,
        'tag canonical name must be a string, got ' + _describeType(canonical)
      );
      continue;
    }
    if (canonical.length > MAX_TAG_CANONICAL_LENGTH) {
      _pushError(
        errors,
        entryPath,
        'tag canonical name length ' +
          canonical.length +
          ' exceeds maximum of ' +
          MAX_TAG_CANONICAL_LENGTH +
          ' characters (will be truncated at apply time)'
      );
    }
    if (_hasOwn(canonicalToRaw, canonical)) {
      _pushWarning(
        warnings,
        entryPath,
        'raw tag "' +
          raw +
          '" maps to the same canonical "' +
          canonical +
          '" as raw tag "' +
          canonicalToRaw[canonical] +
          '"'
      );
    } else {
      canonicalToRaw[canonical] = raw;
    }
  }
}

function _validateRoutingHints(hints, errors, warnings) {
  if (hints === undefined) {
    return;
  }
  var path = 'routing_hints';
  if (!_isPlainObject(hints)) {
    _pushError(
      errors,
      path,
      'routing_hints must be an object, got ' + _describeType(hints)
    );
    return;
  }
  var subSections = [
    { key: 'domains', valueDescription: 'category slug' },
    { key: 'source_categories', valueDescription: 'category slug' },
    { key: 'category_to_author', valueDescription: 'author username' },
  ];
  for (var i = 0; i < subSections.length; i++) {
    var sub = subSections[i];
    if (hints[sub.key] === undefined) {
      continue;
    }
    var subPath = path + '.' + sub.key;
    if (!_isPlainObject(hints[sub.key])) {
      _pushError(
        errors,
        subPath,
        sub.key +
          ' must be an object mapping string to ' +
          sub.valueDescription +
          ', got ' +
          _describeType(hints[sub.key])
      );
      continue;
    }
    for (var mapKey in hints[sub.key]) {
      if (!_hasOwn(hints[sub.key], mapKey)) {
        continue;
      }
      var mapVal = hints[sub.key][mapKey];
      var mapPath = subPath + '["' + mapKey + '"]';
      if (!_isString(mapVal)) {
        _pushError(
          errors,
          mapPath,
          'value must be a string (' +
            sub.valueDescription +
            '), got ' +
            _describeType(mapVal)
        );
        continue;
      }
      if (sub.key === 'category_to_author') {
        if (!USERNAME_RE.test(mapVal)) {
          _pushError(
            errors,
            mapPath,
            'author username must match /^[a-z0-9_-]+$/; got "' + mapVal + '"'
          );
        }
      } else {
        if (!SLUG_RE.test(mapVal)) {
          _pushError(
            errors,
            mapPath,
            'category slug must match /^[a-z0-9-]+$/; got "' + mapVal + '"'
          );
        }
      }
    }
  }
}

function _validatePublishRuleMatch(match, rulePath, errors) {
  var path = rulePath + '.match';
  if (match === undefined) {
    _pushError(errors, path, 'match is required');
    return;
  }
  if (!_isPlainObject(match)) {
    _pushError(
      errors,
      path,
      'match must be an object, got ' + _describeType(match)
    );
    return;
  }
  var fields = ['source_domain', 'source_category', 'title_keyword'];
  for (var i = 0; i < fields.length; i++) {
    var field = fields[i];
    if (match[field] === undefined || match[field] === null) {
      continue;
    }
    if (!_isString(match[field])) {
      _pushError(
        errors,
        path + '.' + field,
        field + ' must be a string or null, got ' + _describeType(match[field])
      );
    }
  }
}

function _validatePublishRuleAssign(assign, rulePath, errors, warnings) {
  var path = rulePath + '.assign';
  if (assign === undefined) {
    _pushError(errors, path, 'assign is required');
    return;
  }
  if (!_isPlainObject(assign)) {
    _pushError(
      errors,
      path,
      'assign must be an object, got ' + _describeType(assign)
    );
    return;
  }
  var hasAnyAssignment = false;
  if (assign.category_slugs !== undefined && assign.category_slugs !== null) {
    if (!_isArray(assign.category_slugs)) {
      _pushError(
        errors,
        path + '.category_slugs',
        'category_slugs must be an array, got ' + _describeType(assign.category_slugs)
      );
    } else {
      if (assign.category_slugs.length > 0) {
        hasAnyAssignment = true;
      }
      for (var i = 0; i < assign.category_slugs.length; i++) {
        var slug = assign.category_slugs[i];
        var slugPath = path + '.category_slugs[' + i + ']';
        if (!_isString(slug)) {
          _pushError(
            errors,
            slugPath,
            'slug must be a string, got ' + _describeType(slug)
          );
        } else if (!SLUG_RE.test(slug)) {
          _pushError(
            errors,
            slugPath,
            'slug must match /^[a-z0-9-]+$/; got "' + slug + '"'
          );
        }
      }
    }
  }
  if (
    assign.primary_category_slug !== undefined &&
    assign.primary_category_slug !== null
  ) {
    if (!_isString(assign.primary_category_slug)) {
      _pushError(
        errors,
        path + '.primary_category_slug',
        'primary_category_slug must be a string or null, got ' +
          _describeType(assign.primary_category_slug)
      );
    } else if (!SLUG_RE.test(assign.primary_category_slug)) {
      _pushError(
        errors,
        path + '.primary_category_slug',
        'primary_category_slug must match /^[a-z0-9-]+$/; got "' +
          assign.primary_category_slug +
          '"'
      );
    } else {
      hasAnyAssignment = true;
    }
  }
  if (assign.tag_slugs !== undefined && assign.tag_slugs !== null) {
    if (!_isArray(assign.tag_slugs)) {
      _pushError(
        errors,
        path + '.tag_slugs',
        'tag_slugs must be an array, got ' + _describeType(assign.tag_slugs)
      );
    } else {
      if (assign.tag_slugs.length > 0) {
        hasAnyAssignment = true;
      }
      for (var j = 0; j < assign.tag_slugs.length; j++) {
        var tagSlug = assign.tag_slugs[j];
        var tagSlugPath = path + '.tag_slugs[' + j + ']';
        if (!_isString(tagSlug)) {
          _pushError(
            errors,
            tagSlugPath,
            'tag slug must be a string, got ' + _describeType(tagSlug)
          );
        } else if (!SLUG_RE.test(tagSlug)) {
          _pushError(
            errors,
            tagSlugPath,
            'tag slug must match /^[a-z0-9-]+$/; got "' + tagSlug + '"'
          );
        }
      }
    }
  }
  if (assign.author_username !== undefined && assign.author_username !== null) {
    if (!_isString(assign.author_username)) {
      _pushError(
        errors,
        path + '.author_username',
        'author_username must be a string or null, got ' +
          _describeType(assign.author_username)
      );
    } else if (!USERNAME_RE.test(assign.author_username)) {
      _pushError(
        errors,
        path + '.author_username',
        'author_username must match /^[a-z0-9_-]+$/; got "' +
          assign.author_username +
          '"'
      );
    } else {
      hasAnyAssignment = true;
    }
  }
  if (!hasAnyAssignment) {
    _pushWarning(
      warnings,
      path,
      'assign block has no effective assignments — this publish_rule is a no-op'
    );
  }
}

function _validatePublishRule(rule, index, errors, warnings, seenKeys) {
  var path = 'publish_rules[' + index + ']';
  if (!_isPlainObject(rule)) {
    _pushError(
      errors,
      path,
      'publish_rule entry must be an object, got ' + _describeType(rule)
    );
    return;
  }
  if (!_hasOwn(rule, 'key')) {
    _pushError(errors, path + '.key', 'key is required');
  } else if (!_isString(rule.key)) {
    _pushError(
      errors,
      path + '.key',
      'key must be a string, got ' + _describeType(rule.key)
    );
  } else if (!RULE_KEY_RE.test(rule.key)) {
    _pushError(
      errors,
      path + '.key',
      'key must match /^[a-z0-9_]+$/; got "' + rule.key + '"'
    );
  } else {
    if (_hasOwn(seenKeys, rule.key)) {
      _pushError(
        errors,
        path + '.key',
        'duplicate publish_rule key "' +
          rule.key +
          '" (first seen at publish_rules[' +
          seenKeys[rule.key] +
          '])'
      );
    } else {
      seenKeys[rule.key] = index;
    }
  }
  if (!_hasOwn(rule, 'name')) {
    _pushError(errors, path + '.name', 'name is required');
  } else if (!_isString(rule.name)) {
    _pushError(
      errors,
      path + '.name',
      'name must be a string, got ' + _describeType(rule.name)
    );
  } else if (rule.name.length === 0) {
    _pushError(errors, path + '.name', 'name must not be empty');
  }
  if (!_hasOwn(rule, 'priority')) {
    _pushError(errors, path + '.priority', 'priority is required');
  } else if (typeof rule.priority !== 'number' || !isFinite(rule.priority)) {
    _pushError(
      errors,
      path + '.priority',
      'priority must be a number, got ' + _describeType(rule.priority)
    );
  } else if (!_isInteger(rule.priority)) {
    _pushError(
      errors,
      path + '.priority',
      'priority must be an integer, got ' + rule.priority
    );
  } else if (rule.priority < 0 || rule.priority > 1000) {
    _pushError(
      errors,
      path + '.priority',
      'priority must be between 0 and 1000 inclusive, got ' + rule.priority
    );
  }
  if (rule.is_active !== undefined && !_isBoolean(rule.is_active)) {
    _pushError(
      errors,
      path + '.is_active',
      'is_active must be a boolean, got ' + _describeType(rule.is_active)
    );
  }
  _validatePublishRuleMatch(rule.match, path, errors);
  _validatePublishRuleAssign(rule.assign, path, errors, warnings);
}

function _validateModulesSection(modules, errors, warnings) {
  if (modules === undefined) {
    return;
  }
  var path = 'modules';
  if (!_isPlainObject(modules)) {
    _pushError(
      errors,
      path,
      'modules must be an object, got ' + _describeType(modules)
    );
    return;
  }
  for (var modName in modules) {
    if (!_hasOwn(modules, modName)) {
      continue;
    }
    if (_indexOf(KNOWN_MODULE_KEYS, modName) === -1) {
      _pushWarning(
        warnings,
        path + '.' + modName,
        'unknown modules entry "' +
          modName +
          '" — expected one of: ' +
          KNOWN_MODULE_KEYS.join(', ')
      );
      continue;
    }
    var modVal = modules[modName];
    var modPath = path + '.' + modName;
    if (!_isPlainObject(modVal)) {
      _pushError(
        errors,
        modPath,
        modName + ' must be an object, got ' + _describeType(modVal)
      );
      continue;
    }
    if (modVal.default_author !== undefined) {
      if (!_isString(modVal.default_author)) {
        _pushError(
          errors,
          modPath + '.default_author',
          'default_author must be a string, got ' + _describeType(modVal.default_author)
        );
      } else if (!USERNAME_RE.test(modVal.default_author)) {
        _pushError(
          errors,
          modPath + '.default_author',
          'default_author must match /^[a-z0-9_-]+$/; got "' +
            modVal.default_author +
            '"'
        );
      }
    }
    var categorySlugField = modName === 'news_pipeline' ? 'fallback_category' : 'category_slug';
    if (modVal[categorySlugField] !== undefined) {
      if (!_isString(modVal[categorySlugField])) {
        _pushError(
          errors,
          modPath + '.' + categorySlugField,
          categorySlugField +
            ' must be a string, got ' +
            _describeType(modVal[categorySlugField])
        );
      } else if (!SLUG_RE.test(modVal[categorySlugField])) {
        _pushError(
          errors,
          modPath + '.' + categorySlugField,
          categorySlugField +
            ' must match /^[a-z0-9-]+$/; got "' +
            modVal[categorySlugField] +
            '"'
        );
      }
    }
    if (modVal.default_tags !== undefined) {
      if (!_isArray(modVal.default_tags)) {
        _pushError(
          errors,
          modPath + '.default_tags',
          'default_tags must be an array of strings, got ' +
            _describeType(modVal.default_tags)
        );
      } else {
        for (var t = 0; t < modVal.default_tags.length; t++) {
          if (!_isString(modVal.default_tags[t])) {
            _pushError(
              errors,
              modPath + '.default_tags[' + t + ']',
              'default_tags entry must be a string, got ' +
                _describeType(modVal.default_tags[t])
            );
          }
        }
      }
    }
  }
}

function validate(parsedConfig) {
  var errors = [];
  var warnings = [];

  try {
    if (!_isPlainObject(parsedConfig)) {
      _pushError(
        errors,
        '',
        'top-level config must be a plain object, got ' + _describeType(parsedConfig)
      );
      return {
        ok: false,
        errors: errors,
        warnings: warnings,
      };
    }

    // Version — required, must be exactly "1.0"
    if (!_hasOwn(parsedConfig, 'version')) {
      _pushError(errors, 'version', 'version is required and must be the string "1.0"');
    } else if (parsedConfig.version !== '1.0') {
      _pushError(
        errors,
        'version',
        'version must be exactly "1.0"; got ' +
          (_isString(parsedConfig.version)
            ? '"' + parsedConfig.version + '"'
            : _describeType(parsedConfig.version))
      );
    }

    // generated_at — optional, string; warn if not parseable ISO date
    if (parsedConfig.generated_at !== undefined) {
      if (!_isString(parsedConfig.generated_at)) {
        _pushError(
          errors,
          'generated_at',
          'generated_at must be a string, got ' + _describeType(parsedConfig.generated_at)
        );
      } else {
        var ts = Date.parse(parsedConfig.generated_at);
        if (isNaN(ts)) {
          _pushWarning(
            warnings,
            'generated_at',
            'generated_at "' + parsedConfig.generated_at + '" is not a parseable ISO 8601 date'
          );
        }
      }
    }

    // notes — optional, informational only
    if (parsedConfig.notes !== undefined) {
      _pushWarning(warnings, 'notes', 'notes field present (parsed, never blocking)');
      if (!_isString(parsedConfig.notes)) {
        _pushError(
          errors,
          'notes',
          'notes must be a string, got ' + _describeType(parsedConfig.notes)
        );
      }
    }

    // Unknown top-level keys — warn to catch typos
    for (var topKey in parsedConfig) {
      if (!_hasOwn(parsedConfig, topKey)) {
        continue;
      }
      if (_indexOf(KNOWN_TOP_LEVEL_KEYS, topKey) === -1) {
        _pushWarning(
          warnings,
          topKey,
          'unknown top-level key "' +
            topKey +
            '" — expected one of: ' +
            KNOWN_TOP_LEVEL_KEYS.join(', ') +
            ' (silently ignored but possibly a typo)'
        );
      }
    }

    // defaults
    _validateDefaults(parsedConfig.defaults, errors, warnings);

    // authors
    if (parsedConfig.authors !== undefined) {
      if (!_isArray(parsedConfig.authors)) {
        _pushError(
          errors,
          'authors',
          'authors must be an array, got ' + _describeType(parsedConfig.authors)
        );
      } else {
        var seenUsernames = {};
        for (var ai = 0; ai < parsedConfig.authors.length; ai++) {
          _validateAuthor(
            parsedConfig.authors[ai],
            ai,
            errors,
            warnings,
            seenUsernames
          );
        }
      }
    }

    // categories
    if (parsedConfig.categories !== undefined) {
      if (!_isArray(parsedConfig.categories)) {
        _pushError(
          errors,
          'categories',
          'categories must be an array, got ' + _describeType(parsedConfig.categories)
        );
      } else {
        var seenSlugs = {};
        for (var ci = 0; ci < parsedConfig.categories.length; ci++) {
          _validateCategory(
            parsedConfig.categories[ci],
            ci,
            errors,
            warnings,
            seenSlugs
          );
        }
      }
    }

    // tags
    _validateTags(parsedConfig.tags, errors, warnings);

    // routing_hints
    _validateRoutingHints(parsedConfig.routing_hints, errors, warnings);

    // publish_rules
    if (parsedConfig.publish_rules !== undefined) {
      if (!_isArray(parsedConfig.publish_rules)) {
        _pushError(
          errors,
          'publish_rules',
          'publish_rules must be an array, got ' +
            _describeType(parsedConfig.publish_rules)
        );
      } else {
        var seenRuleKeys = {};
        for (var ri = 0; ri < parsedConfig.publish_rules.length; ri++) {
          _validatePublishRule(
            parsedConfig.publish_rules[ri],
            ri,
            errors,
            warnings,
            seenRuleKeys
          );
        }
      }
    }

    // modules (forward-compat, parsed but not used in v1)
    _validateModulesSection(parsedConfig.modules, errors, warnings);
  } catch (e) {
    // Internal validation should never throw, but if it does,
    // surface it as a hard error instead of propagating.
    _pushError(
      errors,
      '',
      'internal validator error: ' + (e && e.message ? e.message : String(e))
    );
  }

  return {
    ok: errors.length === 0,
    errors: errors,
    warnings: warnings,
  };
}

module.exports = { validate: validate };
