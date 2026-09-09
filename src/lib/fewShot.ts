// Few-shot exemplars for Text-to-SQL.
//
// Targets the dominant measured failure: small models substitute a GROUP BY
// aggregate or a self-join where a window function is required, producing
// valid SQL that answers a different question. Prohibitions did not fix that
// (see evals/README.md, "Factorial test"); demonstrations are the remaining
// prompt-level lever.
//
// Two rules govern this file.
//
// 1. Exemplars use a DIFFERENT schema (employees/departments) from anything in
//    the eval fixture or a user's database. Writing them against the fixture
//    would leak the test set and turn the benchmark into a memorisation check.
//    They teach the shape of the answer, never the answer.
//
// 2. The library is not all window functions. A GROUP BY exemplar is included
//    on purpose: steering hard toward windows regressed unrelated cases when
//    tried as a directive, so the contrast case is there to keep aggregation
//    from drifting.

export interface Exemplar {
    question: string;
    sql: string;
    /** Retrieval keywords. Lowercase, matched against the user's question. */
    tags: string[];
}

export const EXEMPLARS: Exemplar[] = [
    {
        question:
            'For each employee show their name and how many employees work in their department.',
        sql: 'SELECT e.name, COUNT(*) OVER (PARTITION BY e.department_id) FROM employees e',
        tags: ['each', 'every', 'how many', 'count', 'per', 'alongside', 'along with', 'their'],
    },
    {
        question: 'Show the two highest paid employees in each department.',
        sql:
            'SELECT name, salary FROM (SELECT e.name AS name, e.salary AS salary, ' +
            'ROW_NUMBER() OVER (PARTITION BY e.department_id ORDER BY e.salary DESC) AS rn ' +
            'FROM employees e) ranked WHERE rn <= 2',
        tags: ['top', 'highest', 'lowest', 'most', 'least', 'first', 'two', 'three', 'each', 'per'],
    },
    {
        question: 'Show each employee id, their salary, and the salary of the previous hire by hire date.',
        sql:
            'SELECT e.id, e.salary, LAG(e.salary) OVER (ORDER BY e.hire_date, e.id) FROM employees e',
        tags: ['previous', 'prior', 'next', 'before', 'after', 'preceding', 'following', 'difference'],
    },
    {
        question:
            'For each employee show their name and the name of the highest paid employee in their department.',
        sql:
            'SELECT e.name, FIRST_VALUE(e.name) OVER (PARTITION BY e.department_id ' +
            'ORDER BY e.salary DESC, e.id) FROM employees e',
        tags: ['name of', 'highest', 'lowest', 'most', 'least', 'best', 'worst', 'their'],
    },
    {
        question:
            'Show each employee id, their salary, and a running total of salaries ordered by hire date.',
        sql:
            'SELECT e.id, e.salary, SUM(e.salary) OVER (ORDER BY e.hire_date, e.id) FROM employees e',
        tags: ['running', 'cumulative', 'total', 'so far', 'up to', 'rank', 'ranked', 'ranking'],
    },
    {
        // Contrast case. Not every aggregate question wants a window function;
        // this one legitimately collapses rows and must keep doing so.
        question: 'How many employees are in each department? Show the department name and the count.',
        sql:
            'SELECT d.name, COUNT(e.id) FROM departments d JOIN employees e ' +
            'ON e.department_id = d.id GROUP BY d.name',
        tags: ['how many', 'count', 'total', 'group', 'each department', 'summar'],
    },
];

const WORD_RE = /[a-z]+/g;

/**
 * Rank exemplars against a question by tag overlap.
 *
 * Deliberately lexical rather than embedding-based. It is deterministic, which
 * keeps eval runs reproducible, and it adds no model load to a client that may
 * be running entirely on CPU. LiteDB already ships on-device embeddings
 * (Transformers.js, MiniLM/BGE) for vector search, so swapping in semantic
 * retrieval later is a drop-in replacement for this function — worth doing
 * only if the cheap version proves the exemplars help at all.
 */
export function selectExemplars(question: string, k: number): Exemplar[] {
    if (k <= 0) return [];

    const words = new Set(question.toLowerCase().match(WORD_RE) ?? []);
    const lower = question.toLowerCase();

    const scored = EXEMPLARS.map((exemplar, index) => {
        let score = 0;
        for (const tag of exemplar.tags) {
            // Multi-word tags are phrases; single words match the token set.
            if (tag.includes(' ')) {
                if (lower.includes(tag)) score += 2;
            } else if (words.has(tag)) {
                score += 1;
            }
        }
        return { exemplar, score, index };
    });

    // Stable ordering on ties so the prompt is byte-identical across runs.
    scored.sort((a, b) => b.score - a.score || a.index - b.index);

    return scored
        .filter((s) => s.score > 0)
        .slice(0, k)
        .map((s) => s.exemplar);
}
