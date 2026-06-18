import argparse
import collections
import json
import os
import re
import sqlite3

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
MAX_SYNONYMS = 8
TAIL_RATIO = 0.34

_SUFFIXES = sorted(
    [
        "иями", "ями", "ами", "ого", "ему", "ыми", "ими", "ться", "тись",
        "ость", "ости", "остью", "ением", "ание", "ания", "ешь", "ишь",
        "ает", "яет", "ует", "ают", "яют", "уют", "или", "али", "ая", "яя",
        "ое", "ее", "ые", "ие", "ый", "ий", "ой", "ую", "юю", "ать", "ять",
        "ить", "еть", "ти", "ся", "ах", "ях", "ам", "ям", "ом", "ем", "ою",
        "ею", "ия", "ие", "а", "я", "о", "е", "ы", "и", "у", "ю",
    ],
    key=len,
    reverse=True,
)

_SEED_GROUPS = [
    ["говорить", "сказать", "разговаривать", "произносить", "молвить", "беседовать"],
    ["смотреть", "глядеть", "видеть", "взглянуть"],
    ["бросать", "кидать", "швырять", "метать", "кинуть"],
    ["большой", "крупный", "огромный", "значительный"],
    ["маленький", "небольшой", "малый", "крошечный"],
    ["красивый", "прекрасный", "симпатичный", "привлекательный", "пригожий"],
    ["быстрый", "скорый", "стремительный"],
    ["медленный", "неторопливый", "неспешный"],
    ["идти", "шагать", "ходить", "ступать"],
    ["бежать", "мчаться", "нестись"],
    ["дом", "жилище", "изба", "здание"],
    ["дорога", "путь", "тропа"],
    ["еда", "пища", "кушанье", "снедь"],
    ["вода", "влага"],
    ["ребенок", "дитя", "малыш"],
    ["человек", "личность", "персона"],
    ["работать", "трудиться"],
    ["думать", "мыслить", "размышлять", "полагать"],
    ["сильный", "мощный", "крепкий"],
    ["слабый", "немощный", "хилый"],
    ["хороший", "добрый", "славный"],
    ["плохой", "дурной", "скверный", "негодный"],
    ["умирать", "погибать", "скончаться"],
    ["любить", "обожать"],
    ["холодный", "студеный", "морозный"],
    ["теплый", "жаркий", "горячий"],
]


def normalize(value):
    """Lower-case, fold ``ё`` to ``е`` and collapse whitespace."""
    value = (value or "").lower().replace("ё", "е")
    return re.sub(r"\s+", " ", value).strip()


def stem(value):
    """Return a crude Russian stem.

    A direct port of ``russianStem`` in app.js: strip non-Cyrillic characters,
    keep words of four letters or fewer intact, otherwise drop the longest
    matching suffix that still leaves a stem of at least three letters.
    """
    word = re.sub(r"[^а-яе-]", "", normalize(value))
    if len(word) <= 4:
        return word
    for suffix in _SUFFIXES:
        if word.endswith(suffix) and len(word) - len(suffix) >= 3:
            return word[: -len(suffix)]
    return word


def load_entries(name):
    """Load the ``entries`` array of a dictionary JSON file in ``data/``."""
    with open(os.path.join(DATA_DIR, name), encoding="utf-8") as handle:
        payload = json.load(handle)
    return payload["entries"] if isinstance(payload, dict) else payload


def russian_vocabulary():
    """Collect Russian word-form frequencies from the searchable Russian side
    of every dictionary (translations, Russian head-words, descriptions)."""
    forms = collections.Counter()

    def add(text):
        for word in re.findall(r"[а-яёА-ЯЁ]+", text or ""):
            forms[word.lower()] += 1

    for entry in load_entries("altai_russian_dictionary_2018.json"):
        add(entry.get("translation_text"))
    for name in (
        "russian_altai_dictionary_2015_tom1_a_o.json",
        "russian_altai_dictionary_2016_tom2_p_ya.json",
    ):
        for entry in load_entries(name):
            add(entry.get("headword_normalized") or entry.get("headword"))
    for entry in load_entries("altai_ethnographic_dictionary_2023.json"):
        add(entry.get("entry_text"))
    return forms


def load_synsets(db_path):
    """Return ``synset_id -> {single-word lemmas}`` from RuWordNet."""
    if not os.path.exists(db_path):
        raise SystemExit(
            f"RuWordNet database not found: {db_path}\n"
            "Download ruwordnet-2021.db from "
            "https://github.com/avidale/python-ruwordnet or pass --db."
        )
    synset_words = collections.defaultdict(set)
    with sqlite3.connect(db_path) as con:
        for synset_id, name in con.execute("SELECT synset_id, name FROM sense"):
            word = name.strip().lower().replace("ё", "е")
            if " " in word or not re.fullmatch(r"[а-я-]+", word):
                continue
            synset_words[synset_id].add(word)
    return synset_words


def build_index(forms, synset_words):
    """Build the ``by_word`` / ``by_stem`` synonym maps."""
    vocab_stems = {stem(word) for word in forms}

    word_to_synsets = collections.defaultdict(set)
    for synset_id, words in synset_words.items():
        for word in words:
            word_to_synsets[word].add(synset_id)

    seed = collections.defaultdict(list)
    for group in _SEED_GROUPS:
        for word in group:
            for other in group:
                if other != word and other not in seed[word]:
                    seed[word].append(other)

    def thesaurus_synonyms(query):
        """Tightness-ranked synonyms of ``query`` from RuWordNet, restricted to
        words findable in the dictionaries."""
        shared_sizes = collections.defaultdict(list)
        for synset_id in word_to_synsets.get(query, ()):
            size = len(synset_words[synset_id])
            for word in synset_words[synset_id]:
                if word != query:
                    shared_sizes[word].append(size)

        scored = [
            (word, sum(1.0 / size for size in sizes))
            for word, sizes in shared_sizes.items()
            if stem(word) in vocab_stems
        ]
        if not scored:
            return []
        scored.sort(key=lambda item: (-item[1], -forms.get(item[0], 0), item[0]))
        best = scored[0][1]
        return [
            word
            for index, (word, weight) in enumerate(scored)
            if index == 0 or weight >= TAIL_RATIO * best
        ]

    def synonyms_for(query):
        chosen = [w for w in seed.get(query, []) if stem(w) in vocab_stems]
        for word in thesaurus_synonyms(query):
            if word != query and word not in chosen:
                chosen.append(word)
        return chosen[:MAX_SYNONYMS]

    candidates = set(word_to_synsets) | set(seed)
    by_word = {}
    for query in candidates:
        synonyms = synonyms_for(query)
        if synonyms:
            by_word[query] = synonyms

    by_stem_sets = collections.defaultdict(list)
    for query, synonyms in by_word.items():
        bucket = by_stem_sets[stem(query)]
        for word in synonyms:
            if word not in bucket:
                bucket.append(word)
    by_stem = {key: words[:MAX_SYNONYMS] for key, words in by_stem_sets.items()}

    return by_word, by_stem


def main():
    parser = argparse.ArgumentParser(description="Build the synonym index.")
    parser.add_argument(
        "--db",
        default=os.environ.get("RUWORDNET_DB", "ruwordnet-2021.db"),
        help="path to ruwordnet-2021.db",
    )
    args = parser.parse_args()

    forms = russian_vocabulary()
    synset_words = load_synsets(args.db)
    by_word, by_stem = build_index(forms, synset_words)

    index = {
        "schema_version": "1.1",
        "model": "ruwordnet-2021-synsets+seed",
        "description": (
            "Russian synonyms from RuWordNet 2021 synsets, tightness-ranked and "
            "restricted to words whose stem occurs in the dictionaries, with a "
            "hand-checked seed for common words."
        ),
        "word_count": len(by_word),
        "by_word": by_word,
        "by_stem": by_stem,
    }

    out_path = os.path.join(DATA_DIR, "synonym_index.json")
    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump(index, handle, ensure_ascii=False, separators=(",", ":"))

    size_mb = os.path.getsize(out_path) / 1e6
    print(
        f"by_word: {len(by_word)}  by_stem: {len(by_stem)}  size: {size_mb:.2f} MB"
    )


if __name__ == "__main__":
    main()
