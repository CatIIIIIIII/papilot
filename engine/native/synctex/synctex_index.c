/* A SyncTeX scanner that stays open: the file is parsed once, then every
 * forward query (what `synctex view -i line:0:input -o output` answers)
 * is a lookup in the scanner's own index of nodes by input tag and line.
 * Results are written as doubles: page, x, y, h, v, W, H per node, with the
 * same expressions synctex_main.c prints. */
#include <stdlib.h>
#include "synctex_parser.h"
#include "synctex_parser_advanced.h"

static synctex_scanner_p scanner = NULL;
static double *results = NULL;
static int capacity = 0;

__attribute__((export_name("st_alloc"))) void *st_alloc(unsigned long size) { return malloc(size); }
__attribute__((export_name("st_free"))) void st_free(void *pointer) { free(pointer); }

__attribute__((export_name("st_open"))) int st_open(const char *output) {
    if (scanner) synctex_scanner_free(scanner);
    scanner = synctex_scanner_new_with_output_file(output, NULL, 1);
    return scanner != NULL;
}

__attribute__((export_name("st_close"))) void st_close(void) {
    if (scanner) synctex_scanner_free(scanner);
    scanner = NULL;
}

/* Returns the number of results, or -1 without a scanner. */
__attribute__((export_name("st_view"))) int st_view(const char *input, int line) {
    int count = 0;
    synctex_node_p node;
    if (!scanner) return -1;
    /* synctex_main.c: page hint 0 when -i names no page. */
    if (!synctex_display_query(scanner, input, line, 0, 0)) return 0;
    while ((node = synctex_scanner_next_result(scanner)) != NULL) {
        if (count == capacity) {
            capacity = capacity ? 2 * capacity : 64;
            results = realloc(results, sizeof(double) * 7 * capacity);
        }
        double *row = results + 7 * count++;
        row[0] = synctex_node_page(node);
        row[1] = synctex_node_visible_h(node);
        row[2] = synctex_node_visible_v(node);
        row[3] = synctex_node_box_visible_h(node);
        row[4] = synctex_node_box_visible_v(node) + synctex_node_box_visible_depth(node);
        row[5] = synctex_node_box_visible_width(node);
        row[6] = synctex_node_box_visible_height(node) + synctex_node_box_visible_depth(node);
    }
    return count;
}

__attribute__((export_name("st_results"))) double *st_results(void) { return results; }

/* Actual hboxes and their line baselines. A child can extend outside a zero
 * height parent (raisebox/smash), so walk the tree without clipping to parents.
 * Horizontal-list edges carry inline vertical offsets; vertical-list edges
 * place independent flow lines. Keep the former through nested boxes while
 * ignoring the latter, so raising a fraction differs from reflowing its rows. */
static double *boxes = NULL;
static int box_capacity = 0;
static int box_count = 0;
static void collect_boxes(synctex_node_p node, double offset, int depth, int horizontal, double parent_v) {
    for (; node; node = synctex_node_sibling(node)) {
        synctex_node_type_t type = synctex_node_target_type(node);
        int hbox = type == synctex_node_type_hbox || type == synctex_node_type_void_hbox;
        double v = synctex_node_visible_v(node);
        double shifted = offset + (horizontal ? v - parent_v : 0);
        if (hbox) {
            if (box_count == box_capacity) {
                box_capacity = box_capacity ? 2 * box_capacity : 64;
                boxes = realloc(boxes, sizeof(double) * 7 * box_capacity);
            }
            double *row = boxes + 7 * box_count++;
            row[0] = synctex_node_visible_h(node);
            row[1] = synctex_node_visible_v(node) - synctex_node_visible_height(node);
            row[2] = row[0] + synctex_node_visible_width(node);
            row[3] = synctex_node_visible_v(node) + synctex_node_visible_depth(node);
            row[4] = v - shifted;
            row[5] = synctex_node_visible_v(node);
            row[6] = depth;
        }
        collect_boxes(synctex_node_child(node), shifted, depth + 1, hbox, v);
    }
}
__attribute__((export_name("st_boxes"))) int st_boxes(int page) {
    box_count = 0;
    if (scanner) collect_boxes(synctex_sheet_content(scanner, page), 0, 0, 0, 0);
    return box_count;
}
__attribute__((export_name("st_box_results"))) double *st_box_results(void) { return boxes; }
