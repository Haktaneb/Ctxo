package org.springframework.web.bind.annotation;

/** Test stub with the real Spring name; no dependency JAR is needed. */
public @interface RequestMapping {
  String[] value() default {};

  String[] path() default {};

  RequestMethod[] method() default {};
}
