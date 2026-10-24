package org.springframework.web.bind.annotation;

/** Test stub with the real Spring name; no dependency JAR is needed. */
public @interface GetMapping {
  String[] value() default {};

  String[] path() default {};
}
