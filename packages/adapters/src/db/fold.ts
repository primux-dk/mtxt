/**
 * The search fold for meetings.title_folded: NFKC, then lower case in
 * JavaScript, which knows æ, ø and å. SQLite's lower() folds ASCII only.
 */
export const foldTitle = (title: string) => title.normalize('NFKC').toLocaleLowerCase();
