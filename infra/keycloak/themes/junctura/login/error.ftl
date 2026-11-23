<#-- SPDX-FileCopyrightText: 2026 Junctura Contributors -->
<#-- SPDX-License-Identifier: Apache-2.0 -->
<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=false; section>
  <#if section = "header">
    ${msg("errorTitle")}
  <#elseif section = "form">
    <#if message.summary == msg("not_assigned_to_app")>
      <p role="alert" data-error-code="not_assigned_to_app">${msg("not_assigned_to_app")}</p>
    <#else>
      <p role="alert">${kcSanitize(message.summary)?no_esc}</p>
    </#if>
    <#if client?? && client.baseUrl?has_content>
      <a href="${client.baseUrl}">${msg("backToApplication")}</a>
    </#if>
  </#if>
</@layout.registrationLayout>
