'use strict';

// ─── Stopwords ───────────────────────────────────────────────────────────────

var STOPWORDS = new Set([
  'the','and','for','are','but','not','you','all','can','had','her','was','one',
  'our','out','has','his','how','its','may','new','now','old','see','way','who',
  'did','get','let','say','she','too','use','will','with','from','this','that',
  'have','been','they','than','them','then','into','over','such','some','year',
  'also','back','after','could','about','would','other','which','their','there',
  'first','every','being','those','still','today','says','said','just','here',
  'most','more','much','what','when','where','know','take','come','made',
  'india','indian','news','report','reports','according','update','updates','latest',
]);

// Category → Author mapping is admin-configurable via CLASSIFIER_CATEGORY_TO_AUTHOR
// (JSON string of {category: author-slug}). Default is empty — when unset, the
// classifier does not assign any author and the publisher falls back to
// WP_AUTHOR_ID from settings. This avoids shipping author slugs that don't
// exist on the admin's WordPress site.

// ─── Source category hints ────────────────────────────────────────────────────

var SOURCE_CATEGORY_HINTS = {
  'entertainment': ['entertainment','movies','bollywood','celebrities','tv','music'],
  'cricket':       ['cricket','sports','ipl'],
  'auto':          ['auto','cars','bikes','tech','technology','gadgets','telecom','mobile'],
  'finance':       ['business','finance','economy','markets','banking','money'],
  'fuel-prices':   ['fuel','petrol','diesel','oil','energy'],
  'gold-silver':   ['gold','silver','commodity','commodities','precious metals'],
};

// ─── Domain hints ─────────────────────────────────────────────────────────────

var DOMAIN_HINTS = {
  'cricket':       ['cricbuzz','espncricinfo','iplt20.com','bcci.tv'],
  'entertainment': ['bollywoodhungama','filmfare','pinkvilla','koimoi'],
  'auto':          ['autocarindia','zigwheels','bikedekho','cardekho','overdrive','motorbeam'],
  'finance':       ['moneycontrol','livemint','economictimes','businesstoday','zeebiz'],
  'fuel-prices':   ['goodreturns.in/petrol','iocl.com'],
  'gold-silver':   ['goodreturns.in/gold','bankbazaar'],
};

// ─── Tag-worthy terms ─────────────────────────────────────────────────────────

var TAG_WORTHY_TERMS = {
  'ipl':              'IPL',
  'bcci':             'BCCI',
  'icc':              'ICC',
  'csk':              'CSK',
  'mumbai indians':   'Mumbai Indians',
  'rcb':              'RCB',
  'kkr':              'KKR',
  'virat kohli':      'Virat Kohli',
  'kohli':            'Virat Kohli',
  'rohit sharma':     'Rohit Sharma',
  'dhoni':            'MS Dhoni',
  'bumrah':           'Jasprit Bumrah',
  'bollywood':        'Bollywood',
  'netflix':          'Netflix',
  'amazon prime':     'Amazon Prime',
  'shah rukh':        'Shah Rukh Khan',
  'srk':              'Shah Rukh Khan',
  'salman khan':      'Salman Khan',
  'deepika':          'Deepika Padukone',
  'alia':             'Alia Bhatt',
  'tesla':            'Tesla',
  'tata motors':      'Tata Motors',
  'maruti':           'Maruti Suzuki',
  'hyundai':          'Hyundai',
  'mahindra':         'Mahindra',
  'royal enfield':    'Royal Enfield',
  'nexon':            'Tata Nexon',
  'creta':            'Hyundai Creta',
  'thar':             'Mahindra Thar',
  'iphone':           'iPhone',
  'samsung':          'Samsung',
  'jio':              'Jio',
  'airtel':           'Airtel',
  '5g':               '5G',
  'sensex':           'Sensex',
  'nifty':            'Nifty',
  'rbi':              'RBI',
  'income tax':       'Income Tax',
  'gst':              'GST',
  'budget':           'Union Budget',
  'mutual fund':      'Mutual Funds',
  'petrol':           'Petrol Prices',
  'diesel':           'Diesel Prices',
  'lpg':              'LPG',
  'cng':              'CNG',
  'crude oil':        'Crude Oil',
  'gold':             'Gold Prices',
  'silver':           'Silver Prices',
  'mcx':              'MCX',
  'modi':             'Narendra Modi',
  'bjp':              'BJP',
  'congress':         'Congress',
  'supreme court':    'Supreme Court',
  'cbse':             'CBSE',
  'neet':             'NEET',
  'jee':              'JEE',
  'upsc':             'UPSC',
  'weather':          'Weather',
  'earthquake':       'Earthquake',
  'world cup':        'World Cup',
  't20':              'T20',
  'test match':       'Test Cricket',
};

// ─── Default category dictionaries ───────────────────────────────────────────

var DEFAULT_CATEGORY_DICTIONARIES = {
  'entertainment': {
    'bollywood': 10, 'movie': 8, 'film': 8, 'actress': 9, 'actor': 9,
    'director': 7, 'trailer': 8, 'box office': 10, 'blockbuster': 8,
    'flop': 7, 'remake': 7, 'sequel': 7, 'biopic': 8, 'netflix': 9,
    'amazon prime': 9, 'hotstar': 9, 'disney': 8, 'jiocinema': 9,
    'zee5': 9, 'sonyliv': 9, 'ott': 9, 'web series': 9, 'streaming': 7,
    'binge': 6, 'episode': 6, 'celebrity': 8, 'net worth': 7, 'salary': 6,
    'lifestyle': 6, 'wedding': 6, 'divorce': 6, 'dating': 5, 'pregnant': 5,
    'award': 7, 'filmfare': 9, 'oscar': 8, 'song': 6, 'album': 6,
    'singer': 7, 'music video': 7, 'reality show': 8, 'bigg boss': 9,
    'dance': 5, 'concert': 6, 'shah rukh': 10, 'srk': 9,
    'salman khan': 10, 'aamir khan': 10, 'deepika': 9, 'ranveer': 9,
    'alia': 8, 'ranbir': 8, 'akshay kumar': 9, 'hrithik': 8,
    'katrina': 8, 'priyanka': 8, 'kareena': 8, 'aishwarya': 8,
    'amitabh': 9, 'kapoor': 5, 'khan': 3,
  },
  'cricket': {
    'cricket': 10, 'ipl': 10, 'bcci': 10, 'icc': 9, 'test match': 10,
    'odi': 9, 't20': 10, 'twenty20': 9, 'wicket': 9, 'innings': 9,
    'century': 7, 'half century': 8, 'maiden': 7, 'bowled': 8, 'lbw': 9,
    'batting': 8, 'bowling': 8, 'opener': 7, 'spinner': 8, 'pacer': 8,
    'allrounder': 8, 'csk': 10, 'chennai super kings': 10,
    'mumbai indians': 10, 'rcb': 10, 'royal challengers': 10, 'kkr': 10,
    'delhi capitals': 10, 'rajasthan royals': 10, 'sunrisers': 10,
    'punjab kings': 10, 'lucknow super giants': 10, 'gujarat titans': 10,
    'virat kohli': 10, 'kohli': 9, 'rohit sharma': 10, 'dhoni': 10,
    'bumrah': 9, 'jadeja': 9, 'ashwin': 9, 'pant': 8, 'siraj': 8,
    'hardik pandya': 9, 'sachin': 9, 'tendulkar': 10, 'gavaskar': 8,
    'dravid': 9, 'world cup': 7, 'asia cup': 9, 'champions trophy': 9,
    'toss': 7, 'umpire': 7, 'drs': 8, 'powerplay': 9, 'super over': 10,
    'wankhede': 8, 'eden gardens': 8, 'chinnaswamy': 8,
  },
  'auto': {
    'bike': 9, 'scooter': 9, 'motorcycle': 9, 'car': 8, 'suv': 9,
    'hatchback': 9, 'sedan': 9, 'truck': 7, 'mileage': 9, 'engine': 7,
    'horsepower': 8, 'torque': 8, 'top speed': 8, 'fuel efficiency': 9,
    'electric vehicle': 10, 'ev': 9, 'battery': 6, 'charging': 7,
    'range anxiety': 9, 'kwh': 9, 'fast charging': 9, 'hybrid': 8,
    'tata motors': 10, 'maruti': 10, 'suzuki': 9, 'hyundai': 10,
    'honda': 8, 'toyota': 9, 'mahindra': 9, 'kia': 9, 'bmw': 9,
    'mercedes': 9, 'audi': 9, 'volkswagen': 8, 'hero': 8, 'bajaj': 9,
    'royal enfield': 10, 'tvs': 9, 'ola electric': 10, 'ather': 10,
    'tesla': 9, 'nexon': 10, 'thar': 10, 'creta': 10, 'seltos': 10,
    'brezza': 10, 'swift': 9, 'baleno': 9, 'innova': 9, 'fortuner': 9,
    'scorpio': 10, 'xuv700': 10, 'harrier': 9, 'pulsar': 10,
    'splendor': 9, 'classic 350': 10, 'activa': 10, 'jupiter': 9,
    'ntorq': 9, 'jio': 8, 'airtel': 8, 'bsnl': 8, 'vodafone': 8,
    'recharge': 8, '5g': 8, 'sim': 7, 'postpaid': 8, 'prepaid': 8,
    'broadband': 8, 'smartphone': 8, 'iphone': 9, 'samsung': 8,
    'pixel': 8, 'oneplus': 8, 'xiaomi': 8, 'redmi': 8, 'realme': 8,
    'vivo': 8, 'oppo': 8, 'showroom': 8, 'ex showroom': 9,
    'on road': 8, 'dealership': 8,
  },
  'finance': {
    'sensex': 10, 'nifty': 10, 'bse': 9, 'nse': 9, 'stock': 8,
    'market': 5, 'bull': 7, 'bear': 7, 'rally': 8, 'crash': 7,
    'ipo': 10, 'listing': 7, 'mutual fund': 10, 'sip': 9, 'nav': 8,
    'etf': 9, 'rbi': 10, 'reserve bank': 10, 'interest rate': 9,
    'repo rate': 10, 'inflation': 9, 'gdp': 9, 'fiscal': 8, 'loan': 7,
    'emi': 8, 'mortgage': 7, 'credit': 6, 'deposit': 7, 'savings': 6,
    'fd': 8, 'fixed deposit': 9, 'ppf': 9, 'nps': 9, 'epf': 9,
    'income tax': 10, 'gst': 10, 'tax': 7, 'itr': 9, 'deduction': 8,
    'exemption': 8, 'section 80c': 10, 'tax slab': 10, 'tds': 9,
    'advance tax': 9, 'rupee': 8, 'dollar': 6, 'forex': 9, 'budget': 8,
    'disinvestment': 9, 'insurance': 7, 'premium': 6, 'lic': 9,
    'health insurance': 8, 'term insurance': 9,
  },
  'fuel-prices': {
    'petrol': 10, 'diesel': 10, 'fuel price': 10, 'fuel prices': 10,
    'petrol price': 10, 'diesel price': 10, 'lpg': 10, 'cylinder': 8,
    'gas cylinder': 9, 'cng': 10, 'png': 8, 'crude oil': 9,
    'brent crude': 10, 'opec': 9, 'iocl': 9, 'bpcl': 9, 'hpcl': 9,
    'petroleum': 9, 'refinery': 8, 'excise duty': 8, 'per litre': 9,
  },
  'gold-silver': {
    'gold': 9, 'silver': 9, 'gold price': 10, 'silver price': 10,
    'gold rate': 10, 'silver rate': 10, 'carat': 9, '24 carat': 10,
    '22 carat': 10, '18 carat': 9, 'hallmark': 9, 'bullion': 10,
    'mcx': 10, 'comex': 10, 'troy ounce': 9, 'tola': 9, 'per gram': 9,
    'per 10 gram': 10, 'jewellery': 7, 'jewelry': 7, 'sovereign': 8,
    'precious metal': 9,
  },
};

// ─── Default author dictionaries ─────────────────────────────────────────────

// deepa-nair merges finance + fuel-prices + gold-silver (higher weight wins)
var _deepaMerged = {};
(function buildDeepaMerged() {
  var cats = ['finance', 'fuel-prices', 'gold-silver'];
  for (var c = 0; c < cats.length; c++) {
    var dict = DEFAULT_CATEGORY_DICTIONARIES[cats[c]];
    var keys = Object.keys(dict);
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      var w = dict[key];
      if (_deepaMerged[key] === undefined || w > _deepaMerged[key]) {
        _deepaMerged[key] = w;
      }
    }
  }
})();

var DEFAULT_AUTHOR_DICTIONARIES = {
  'priya-mehta':  DEFAULT_CATEGORY_DICTIONARIES['entertainment'],
  'arjun-sharma': DEFAULT_CATEGORY_DICTIONARIES['cricket'],
  'rahul-desai':  DEFAULT_CATEGORY_DICTIONARIES['auto'],
  'deepa-nair':   _deepaMerged,
  'karan-verma': {
    'trending': 5, 'viral': 5, 'breaking': 5, 'politics': 5,
    'election': 5, 'government': 4, 'minister': 4, 'parliament': 5,
    'supreme court': 5, 'police': 4, 'arrest': 4, 'protest': 4,
    'bjp': 4, 'congress': 4, 'aap': 4, 'modi': 5, 'rahul gandhi': 5,
    'weather': 4, 'earthquake': 5, 'flood': 5, 'cyclone': 5,
    'accident': 4, 'train': 4, 'flight': 4, 'airport': 4,
    'education': 4, 'exam': 4, 'cbse': 5, 'neet': 5, 'jee': 5,
    'upsc': 5, 'ssc': 5, 'university': 4, 'health': 4, 'hospital': 4,
    'doctor': 4, 'disease': 4, 'vaccine': 5, 'real estate': 5,
    'property': 4, 'housing': 4, 'rera': 6,
  },
};

// ─── ContentClassifier class ──────────────────────────────────────────────────

class ContentClassifier {
  constructor(config, db, logger) {
    this.config = config;
    this.db = db;
    this.logger = logger;
    this._loadDictionaries();
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  _getCategoryAuthorMap() {
    var raw = this.config.get('CLASSIFIER_CATEGORY_TO_AUTHOR');
    if (!raw) return {};
    try { var parsed = JSON.parse(raw); return (parsed && typeof parsed === 'object') ? parsed : {}; }
    catch (e) { return {}; }
  }

  _getDefaultAuthor() {
    return (this.config.get('DEFAULT_AUTHOR_USERNAME') || '').trim();
  }

  // Parse a JSON-string config value, returning the fallback object on any
  // parse failure or empty value. Used for all dictionary/hint overrides
  // populated by the bulk import system.
  _parseJsonSetting(key, fallback) {
    var raw = this.config.get(key);
    if (!raw) return fallback;
    try {
      var parsed = JSON.parse(raw);
      return (parsed && typeof parsed === 'object') ? parsed : fallback;
    } catch (e) {
      if (this.logger) this.logger.warn('[content-classifier] bad JSON in ' + key + ', falling back');
      return fallback;
    }
  }

  // Load all classifier scoring data sources. Setting values populated by the
  // bulk import system override the corresponding hardcoded module constants.
  // This is purely a data-source extension — no scoring logic changes.
  _loadDictionaries() {
    this.categoryDictionaries     = this._parseJsonSetting('CLASSIFIER_CATEGORY_DICTIONARIES', DEFAULT_CATEGORY_DICTIONARIES);
    this.authorDictionaries       = this._parseJsonSetting('CLASSIFIER_AUTHOR_DICTIONARIES',   DEFAULT_AUTHOR_DICTIONARIES);
    this.tagWorthyTerms           = this._parseJsonSetting('CLASSIFIER_TAG_NORMALIZATION',     TAG_WORTHY_TERMS);
    this.domainHints              = this._parseJsonSetting('CLASSIFIER_DOMAIN_HINTS',          DOMAIN_HINTS);
    this.sourceCategoryHints      = this._parseJsonSetting('CLASSIFIER_SOURCE_CATEGORY_HINTS', SOURCE_CATEGORY_HINTS);
  }

  _scoreDictionary(terms, dictionary) {
    var score = 0;
    var matchedTerms = [];
    for (var i = 0; i < terms.length; i++) {
      var term = terms[i];
      if (dictionary[term] !== undefined) {
        score += dictionary[term];
        if (matchedTerms.indexOf(term) === -1) {
          matchedTerms.push(term);
        }
      }
    }
    return { score: score, matchedTerms: matchedTerms };
  }

  _getWinner(scores) {
    var entries = Object.keys(scores).map(function(key) {
      return { key: key, score: scores[key].score, matchedTerms: scores[key].matchedTerms };
    });
    entries.sort(function(a, b) { return b.score - a.score; });
    if (entries.length === 0) {
      return { key: null, score: 0, secondBestScore: 0, matchedTerms: [] };
    }
    return {
      key:             entries[0].key,
      score:           entries[0].score,
      secondBestScore: entries.length > 1 ? entries[1].score : 0,
      matchedTerms:    entries[0].matchedTerms,
    };
  }

  _applySourceBoosts(categoryScores, authorScores, domain, sourceCategory) {
    var domainLower = (domain || '').toLowerCase();
    var sourceCatLower = (sourceCategory || '').toLowerCase();

    // Source category hints → +8 to category score
    var sourceCatHints = this.sourceCategoryHints || SOURCE_CATEGORY_HINTS;
    var catKeys = Object.keys(sourceCatHints);
    for (var ci = 0; ci < catKeys.length; ci++) {
      var catKey = catKeys[ci];
      var hints = sourceCatHints[catKey];
      for (var hi = 0; hi < hints.length; hi++) {
        if (sourceCatLower.indexOf(hints[hi]) !== -1) {
          if (!categoryScores[catKey]) {
            categoryScores[catKey] = { score: 0, matchedTerms: [] };
          }
          categoryScores[catKey].score += 8;
          break;
        }
      }
    }

    // Domain hints → +10 to category score and matching author score
    var catAuthorMap = this._getCategoryAuthorMap();
    var domHints = this.domainHints || DOMAIN_HINTS;
    var domainCatKeys = Object.keys(domHints);
    for (var di = 0; di < domainCatKeys.length; di++) {
      var dCatKey = domainCatKeys[di];
      var domainList = domHints[dCatKey];
      for (var dhi = 0; dhi < domainList.length; dhi++) {
        if (domainLower.indexOf(domainList[dhi]) !== -1) {
          if (!categoryScores[dCatKey]) {
            categoryScores[dCatKey] = { score: 0, matchedTerms: [] };
          }
          categoryScores[dCatKey].score += 10;

          // Boost the matching author too (only if admin has mapped one)
          var matchingAuthor = catAuthorMap[dCatKey];
          if (matchingAuthor) {
            if (!authorScores[matchingAuthor]) {
              authorScores[matchingAuthor] = { score: 0, matchedTerms: [] };
            }
            authorScores[matchingAuthor].score += 10;
          }
          break;
        }
      }
    }
  }

  _extractTags(tokens, bigrams) {
    var all = tokens.concat(bigrams);
    var tags = [];
    var tagMap = this.tagWorthyTerms || TAG_WORTHY_TERMS;
    for (var i = 0; i < all.length; i++) {
      var term = all[i];
      if (tagMap[term] !== undefined) {
        var tag = tagMap[term];
        if (tags.indexOf(tag) === -1) {
          tags.push(tag);
        }
      }
      if (tags.length >= 8) break;
    }
    return tags;
  }

  _buildReasons(bestCat, bestAuthor) {
    var reasons = [];
    if (bestCat && bestCat.key) {
      var catTerms = bestCat.matchedTerms.slice(0, 5).join(', ');
      reasons.push('category:' + bestCat.key + ' (keywords: ' + catTerms + ')');
    }
    if (bestAuthor && bestAuthor.key) {
      var authTerms = bestAuthor.matchedTerms.slice(0, 5).join(', ');
      reasons.push('author:' + bestAuthor.key + ' (keywords: ' + authTerms + ')');
    }
    return reasons;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  scoreLocally(title, content, sourceDomain, sourceCategory) {
    // 1. Tokenize
    var text = (title || '') + ' ' + (content || '').slice(0, 500);
    var rawTokens = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/);
    var tokens = [];
    for (var ti = 0; ti < rawTokens.length; ti++) {
      var w = rawTokens[ti];
      if (w.length > 2 && !STOPWORDS.has(w)) {
        tokens.push(w);
      }
    }

    // 2. Build bigrams
    var bigrams = [];
    for (var bi = 0; bi < tokens.length - 1; bi++) {
      bigrams.push(tokens[bi] + ' ' + tokens[bi + 1]);
    }

    // 3. All terms
    var allTerms = tokens.concat(bigrams);

    // 4. Score categories
    var categoryScores = {};
    var catKeys = Object.keys(this.categoryDictionaries);
    for (var ci = 0; ci < catKeys.length; ci++) {
      var ck = catKeys[ci];
      categoryScores[ck] = this._scoreDictionary(allTerms, this.categoryDictionaries[ck]);
    }

    // 5. Score authors
    var authorScores = {};
    var authKeys = Object.keys(this.authorDictionaries);
    for (var ai = 0; ai < authKeys.length; ai++) {
      var ak = authKeys[ai];
      authorScores[ak] = this._scoreDictionary(allTerms, this.authorDictionaries[ak]);
    }

    // 6. Apply source boosts
    this._applySourceBoosts(categoryScores, authorScores, sourceDomain, sourceCategory);

    // 7. Find winners
    var bestCat    = this._getWinner(categoryScores);
    var bestAuthor = this._getWinner(authorScores);

    // 8. Confidence threshold
    var CONFIDENCE_THRESHOLD = parseFloat(this.config.get('CLASSIFIER_CONFIDENCE_THRESHOLD')) || 15;

    // 9. Extract tags
    var tags = this._extractTags(tokens, bigrams);

    // 10. Build reasons
    var matchReasons = this._buildReasons(bestCat, bestAuthor);

    // If the best category author slot is empty, derive author from the
    // admin-configured category→author map, falling back to the configured
    // default author username. Both come from settings; empty string means
    // "no classifier author, let publish rules / global default decide".
    var resolvedAuthor = bestAuthor.key;
    if (!resolvedAuthor || bestAuthor.score < CONFIDENCE_THRESHOLD) {
      var catAuthorMap = this._getCategoryAuthorMap();
      resolvedAuthor = catAuthorMap[bestCat.key] || this._getDefaultAuthor() || '';
    }

    var catConfident    = bestCat.score >= CONFIDENCE_THRESHOLD;
    var authorConfident = bestAuthor.score >= CONFIDENCE_THRESHOLD;

    return {
      author: {
        username:  resolvedAuthor,
        score:     bestAuthor.score,
        confident: authorConfident,
      },
      category: {
        key:       bestCat.key,
        score:     bestCat.score,
        confident: catConfident,
      },
      tags:         tags,
      allConfident: catConfident && authorConfident,
      matchReasons: matchReasons,
    };
  }

  getCategoryWpIdMap() {
    var map = {};
    try {
      var rows = this.db.prepare(
        "SELECT name, wp_id FROM wp_taxonomy_cache WHERE tax_type = 'category'"
      ).all();
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        // slug form: lowercase, replace non-alphanum with hyphen
        var slug = (row.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
        map[slug]                          = row.wp_id;
        map[(row.name || '').toLowerCase()] = row.wp_id;
      }
    } catch (e) {
      if (this.logger) this.logger.warn('[content-classifier] getCategoryWpIdMap error: ' + e.message);
    }
    return map;
  }

  getAuthorWpIdMap() {
    var map = {};
    try {
      var rows = this.db.prepare(
        "SELECT name, slug, wp_id FROM wp_taxonomy_cache WHERE tax_type = 'author'"
      ).all();
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        if (row.slug) map[row.slug] = row.wp_id;
        if (row.name) map[row.name.toLowerCase()] = row.wp_id;
      }
    } catch (e) {
      if (this.logger) this.logger.warn('[content-classifier] getAuthorWpIdMap error: ' + e.message);
    }
    return map;
  }

  getTagWpIdMap() {
    var map = {};
    try {
      var rows = this.db.prepare(
        "SELECT name, slug, wp_id FROM wp_taxonomy_cache WHERE tax_type = 'tag'"
      ).all();
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        if (row.name) {
          var nameKey = String(row.name).trim().toLowerCase().replace(/\s+/g, ' ');
          if (nameKey) map[nameKey] = row.wp_id;
        }
        if (row.slug) {
          var slugKey = String(row.slug).trim().toLowerCase();
          if (slugKey) map[slugKey] = row.wp_id;
        }
      }
    } catch (e) {
      if (this.logger) this.logger.warn('[content-classifier] getTagWpIdMap error: ' + e.message);
    }
    return map;
  }

  reloadDictionaries() {
    this._loadDictionaries();
    if (this.logger) this.logger.info('[content-classifier] Dictionaries reloaded');
  }

  logClassification(data) {
    try {
      this.db.prepare(
        'INSERT INTO classification_log ' +
        '(draft_id, cluster_id, title, assigned_category, assigned_author, ' +
        'assigned_tags, layer_used, l1_category_score, l1_author_score, ' +
        'l2_ai_confidence, match_reasons) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        data.draft_id   || null,
        data.cluster_id || null,
        data.title      || null,
        data.assigned_category || null,
        data.assigned_author   || null,
        JSON.stringify(Array.isArray(data.assigned_tags) ? data.assigned_tags : []),
        data.layer_used        || null,
        data.l1_category_score != null ? data.l1_category_score : null,
        data.l1_author_score   != null ? data.l1_author_score   : null,
        data.l2_ai_confidence  != null ? data.l2_ai_confidence  : null,
        JSON.stringify(Array.isArray(data.match_reasons) ? data.match_reasons : [])
      );
    } catch (err) {
      if (this.logger) this.logger.error('[content-classifier] logClassification error: ' + err.message);
    }
  }

  getRecentClassifications(limit) {
    return this.db.prepare(
      'SELECT * FROM classification_log ORDER BY created_at DESC LIMIT ?'
    ).all(limit || 50);
  }

  getStats() {
    var since = "datetime('now', '-24 hours')";
    var layerDistribution = this.db.prepare(
      'SELECT layer_used, COUNT(*) as count FROM classification_log ' +
      'WHERE created_at > ' + since + ' GROUP BY layer_used'
    ).all();
    var authorDistribution = this.db.prepare(
      'SELECT assigned_author, COUNT(*) as count FROM classification_log ' +
      'WHERE created_at > ' + since + ' GROUP BY assigned_author'
    ).all();
    var categoryDistribution = this.db.prepare(
      'SELECT assigned_category, COUNT(*) as count FROM classification_log ' +
      'WHERE created_at > ' + since + ' GROUP BY assigned_category'
    ).all();
    return {
      layerDistribution:    layerDistribution,
      authorDistribution:   authorDistribution,
      categoryDistribution: categoryDistribution,
    };
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { ContentClassifier };
