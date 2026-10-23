package org.springframework.web.bind.annotation;

/** Test stub with the real Spring name; no dependency JAR is needed. */
public @interface RestController {
  String value() default "";
}
