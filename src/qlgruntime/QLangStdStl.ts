// QLangStdStl — STL 标准头（stack/queue/vector/pair/priority_queue）
// @ts-nocheck

export var QLANG_STL_HEADER = `
#defNS std

// ---- 容器 (capacity 1000) ----

// stack: push/pop/top/size/empty
stack new_stack() { /* native */ }
void stack_push(stack s, int v) { /* native */ }
int stack_pop(stack s) { /* native */ }
int stack_top(stack s) { /* native */ }
int stack_size(stack s) { /* native */ }
int stack_empty(stack s) { /* native */ }

// queue: push/pop/front/back/size
queue new_queue() { /* native */ }
void queue_push(queue q, int v) { /* native */ }
int queue_pop(queue q) { /* native */ }
int queue_front(queue q) { /* native */ }
int queue_back(queue q) { /* native */ }
int queue_size(queue q) { /* native */ }
int queue_empty(queue q) { /* native */ }

// vector: push_back/pop_back/get/set/size/clear
vector new_vector() { /* native */ }
void vector_push_back(vector v, int x) { /* native */ }
int vector_pop_back(vector v) { /* native */ }
int vector_get(vector v, int i) { /* native */ }
void vector_set(vector v, int i, int x) { /* native */ }
int vector_size(vector v) { /* native */ }
int vector_empty(vector v) { /* native */ }
void vector_clear(vector v) { /* native */ }

// priority_queue (max-heap): push/pop/top/size/empty
priority_queue new_pq() { /* native */ }
void pq_push(priority_queue pq, int v) { /* native */ }
int pq_pop(priority_queue pq) { /* native */ }
int pq_top(priority_queue pq) { /* native */ }
int pq_size(priority_queue pq) { /* native */ }
int pq_empty(priority_queue pq) { /* native */ }

// pair: first/second
pair new_pair(int a, int b) { /* native */ }
int pair_first(pair p) { /* native */ }
int pair_second(pair p) { /* native */ }
`;