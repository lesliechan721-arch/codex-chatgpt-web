// Runtime-only preload. It also works in controlled children that do not import the recovery store.
import "../src/runtime-performance";
import { trackTestChildren } from "./test-performance-children";
trackTestChildren();
