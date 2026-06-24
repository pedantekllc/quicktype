#include <stdio.h>
#include <stdlib.h>
#include <jansson.h>

#include "TopLevel.h"

/* quicktype jansson test driver: parse a JSON file into the generated TopLevel,
 * re-serialize it, print it. The harness diffs the round-trip against the input
 * (semantic JSON equality), and under valgrind asserts no leaks. */
int main(int argc, const char *argv[]) {
    if (argc != 2) {
        printf("Usage: %s FILE\n", argv[0]);
        return 1;
    }

    json_error_t err;
    json_t *root = json_load_file(argv[1], JSON_DECODE_ANY, &err);
    if (root == NULL) {
        fprintf(stderr, "parse error: %s\n", err.text);
        return 1;
    }

    TopLevel tl;
    if (TopLevel_from_json(root, &tl) != 0) {
        json_decref(root);
        return 1;
    }

    json_t *out = TopLevel_to_json(&tl);
    char *s = json_dumps(out, JSON_ENCODE_ANY | JSON_SORT_KEYS);
    if (s == NULL) {
        json_decref(out);
        TopLevel_free(&tl);
        json_decref(root);
        return 1;
    }

    printf("%s\n", s);

    free(s);
    json_decref(out);
    TopLevel_free(&tl);
    json_decref(root);
    return 0;
}
